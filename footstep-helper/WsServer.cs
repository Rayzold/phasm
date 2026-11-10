using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace PhasmListener;

/// <summary>
/// Tiny loopback-only WebSocket server (no http.sys, no admin rights, no firewall prompt).
/// Binary frames = 20 ms of s16le mono audio; text frames = JSON status.
/// Only origins on the allow-list may connect, so a random website can't listen to your game.
/// </summary>
internal sealed class WsServer
{
    private readonly int _port;
    private readonly Func<string?, bool> _originAllowed;
    private readonly Func<string> _helloJson;
    private readonly Func<string> _statusJson;
    private readonly List<Client> _clients = new();
    private readonly object _lock = new();

    public WsServer(int port, Func<string?, bool> originAllowed, Func<string> helloJson, Func<string> statusJson)
    {
        _port = port; _originAllowed = originAllowed; _helloJson = helloJson; _statusJson = statusJson;
    }

    public int ClientCount { get { lock (_lock) return _clients.Count; } }

    public void Start(CancellationToken ct)
    {
        var listeners = new List<TcpListener> { new(IPAddress.Loopback, _port) };
        if (Socket.OSSupportsIPv6) listeners.Add(new TcpListener(IPAddress.IPv6Loopback, _port));
        int bound = 0;
        foreach (var l in listeners)
        {
            try { l.Start(); bound++; _ = AcceptLoop(l, ct); }
            catch (SocketException ex) when (l.LocalEndpoint is IPEndPoint ep && ep.AddressFamily == AddressFamily.InterNetworkV6)
            {
                Log.Warn($"IPv6 loopback not available ({ex.SocketErrorCode}); IPv4 only.");
            }
        }
        if (bound == 0) throw new InvalidOperationException($"Could not listen on port {_port}.");
    }

    public void BroadcastAudio(byte[] frame) => Broadcast(new Msg(frame, WebSocketMessageType.Binary));
    public void BroadcastText(string json) => Broadcast(new Msg(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text));

    private void Broadcast(Msg m)
    {
        lock (_lock) foreach (var c in _clients) c.Queue.Writer.TryWrite(m);
    }

    private async Task AcceptLoop(TcpListener l, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient tcp;
            try { tcp = await l.AcceptTcpClientAsync(ct); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Warn("accept: " + ex.Message); continue; }
            _ = Handle(tcp, ct);
        }
    }

    private async Task Handle(TcpClient tcp, CancellationToken ct)
    {
        using var _ = tcp;
        tcp.NoDelay = true;
        var stream = tcp.GetStream();
        Dictionary<string, string> headers;
        string requestLine;
        try { (requestLine, headers) = await ReadRequest(stream, ct); }
        catch { return; }

        headers.TryGetValue("origin", out var origin);
        bool isUpgrade = headers.TryGetValue("upgrade", out var up) && up.Equals("websocket", StringComparison.OrdinalIgnoreCase);

        if (!isUpgrade)
        {
            // Plain GET: a human-readable "it's running" page.
            string body = $"PhasmListener is running.\n{_statusJson()}\n";
            await WriteRaw(stream, $"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\n\r\n{body}", ct);
            return;
        }
        if (!_originAllowed(origin))
        {
            Log.Warn($"Rejected connection from origin '{origin ?? "(none)"}'. Use --allow-origin to permit it.");
            await WriteRaw(stream, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", ct);
            return;
        }
        if (!headers.TryGetValue("sec-websocket-key", out var key) || !requestLine.StartsWith("GET ", StringComparison.Ordinal))
        {
            await WriteRaw(stream, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", ct);
            return;
        }

        string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await WriteRaw(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                               $"Sec-WebSocket-Accept: {accept}\r\n\r\n", ct);

        using var ws = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = TimeSpan.FromSeconds(20) });
        var client = new Client(ws);
        client.Queue.Writer.TryWrite(new Msg(Encoding.UTF8.GetBytes(_helloJson()), WebSocketMessageType.Text));
        client.Queue.Writer.TryWrite(new Msg(Encoding.UTF8.GetBytes(_statusJson()), WebSocketMessageType.Text));
        lock (_lock) _clients.Add(client);
        Log.Info($"Journal connected ({origin}). Clients: {ClientCount}");

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var sendTask = SendLoop(client, linked.Token);
        try
        {
            var buf = new byte[1024];
            while (ws.State == WebSocketState.Open)
            {
                var r = await ws.ReceiveAsync(buf, linked.Token);
                if (r.MessageType == WebSocketMessageType.Close) break;
            }
        }
        catch { /* client went away */ }
        finally
        {
            lock (_lock) _clients.Remove(client);
            linked.Cancel();
            try { await sendTask; } catch { }
            try { if (ws.State == WebSocketState.Open || ws.State == WebSocketState.CloseReceived) await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { }
            Log.Info($"Journal disconnected. Clients: {ClientCount}");
        }
    }

    private static async Task SendLoop(Client c, CancellationToken ct)
    {
        await foreach (var m in c.Queue.Reader.ReadAllAsync(ct))
            await c.Ws.SendAsync(m.Data, m.Type, true, ct);
    }

    private static async Task<(string, Dictionary<string, string>)> ReadRequest(NetworkStream s, CancellationToken ct)
    {
        var sb = new StringBuilder();
        var one = new byte[1];
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        while (sb.Length < 16384)
        {
            int n = await s.ReadAsync(one, timeout.Token);
            if (n == 0) throw new IOException("closed");
            sb.Append((char)one[0]);
            if (sb.Length >= 4 && sb[^1] == '\n' && sb[^2] == '\r' && sb[^3] == '\n' && sb[^4] == '\r') break;
        }
        var lines = sb.ToString().Split("\r\n");
        var h = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            int i = line.IndexOf(':');
            if (i > 0) h[line[..i].Trim()] = line[(i + 1)..].Trim();
        }
        return (lines[0], h);
    }

    private static Task WriteRaw(NetworkStream s, string text, CancellationToken ct) =>
        s.WriteAsync(Encoding.ASCII.GetBytes(text), ct).AsTask();

    private sealed record Msg(byte[] Data, WebSocketMessageType Type);

    private sealed class Client
    {
        public WebSocket Ws { get; }
        // ~4 s of audio; if the browser tab stalls we drop the oldest frames rather than grow forever.
        public Channel<Msg> Queue { get; } = Channel.CreateBounded<Msg>(new BoundedChannelOptions(200) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
        public Client(WebSocket ws) => Ws = ws;
    }
}

internal static class Log
{
    public static void Info(string m) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {m}");
    public static void Warn(string m) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] ! {m}");
}
