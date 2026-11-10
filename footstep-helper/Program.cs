// PhasmListener — streams ONLY Phasmophobia's audio to the Phasmo Journal footstep detector.
//
//   PhasmListener.exe                      wait for Phasmophobia.exe, capture its audio
//   PhasmListener.exe --port 47213         different port (match it in the Journal)
//   PhasmListener.exe --allow-origin http://my.host:8080
//   PhasmListener.exe --wav test.wav --loop   stream a WAV file instead (testing, any OS)
//
// All detection happens in the browser (footsteps.js), so tuning the algorithm never
// requires a new .exe.

using System.Diagnostics;
using System.Text.Json;

namespace PhasmListener;

internal static class Program
{
    private const string Version = "1.0.0";

    private static string _state = "starting", _message = "";
    private static int? _pid;
    private static string _processName = "Phasmophobia";

    private static int Main(string[] args)
    {
        int port = 47213;
        string? wav = null;
        bool loop = false, anyOrigin = false;
        var extraOrigins = new List<string>();

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{a} needs a value");
            switch (a)
            {
                case "--port": port = int.Parse(Next()); break;
                case "--process": _processName = Path.GetFileNameWithoutExtension(Next()); break;
                case "--wav": wav = Next(); break;
                case "--loop": loop = true; break;
                case "--allow-origin": extraOrigins.Add(Next().TrimEnd('/')); break;
                case "--any-origin": anyOrigin = true; break;
                case "-h": case "--help": PrintHelp(); return 0;
                default: Console.WriteLine($"Unknown option {a}"); PrintHelp(); return 2;
            }
        }

        Console.Title = "PhasmListener — Phasmo Journal";
        Log.Info($"PhasmListener {Version} — ws://localhost:{port}");

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        WsServer? server = null;
        var pipeline = new AudioPipeline(frame => server?.BroadcastAudio(frame));
        server = new WsServer(port,
            origin => anyOrigin || OriginAllowed(origin, extraOrigins),
            () => JsonSerializer.Serialize(new { type = "hello", app = "PhasmListener", version = Version, sampleRate = AudioPipeline.OutRate, format = "s16le-mono", frameMs = 20 }),
            StatusJson);
        try { server.Start(cts.Token); }
        catch (Exception ex)
        {
            Log.Warn(ex.Message + " Is another PhasmListener already running?");
            return 1;
        }

        // Silence padder: keeps the stream on real time while the game is quiet.
        var ticker = new Thread(() => { while (!cts.IsCancellationRequested) { pipeline.Tick(); Thread.Sleep(50); } })
            { IsBackground = true, Name = "PhasmListener.Tick" };
        ticker.Start();

        try
        {
            if (wav != null) RunWav(wav, loop, pipeline, server, cts.Token);
            else if (OperatingSystem.IsWindows()) RunProcessWatcher(pipeline, server, cts.Token);
            else { Log.Warn("Process capture needs Windows 10 (20348+) / 11. Use --wav on other systems."); return 1; }
        }
        catch (OperationCanceledException) { }
        Log.Info("Bye.");
        return 0;
    }

    private static bool OriginAllowed(string? origin, List<string> extra)
    {
        if (string.IsNullOrEmpty(origin)) return false;
        origin = origin.TrimEnd('/');
        if (origin.Equals("https://rayzold.github.io", StringComparison.OrdinalIgnoreCase)) return true;
        if (extra.Any(o => o.Equals(origin, StringComparison.OrdinalIgnoreCase))) return true;
        // Local development copies of the Journal (python -m http.server etc.)
        return Uri.TryCreate(origin, UriKind.Absolute, out var u)
               && (u.Scheme == "http" || u.Scheme == "https")
               && (u.Host == "localhost" || u.Host == "127.0.0.1" || u.Host == "[::1]");
    }

    private static string StatusJson() =>
        JsonSerializer.Serialize(new { type = "status", state = _state, process = _processName, pid = _pid, message = _message });

    private static void SetStatus(WsServer server, string state, int? pid = null, string message = "")
    {
        if (_state == state && _pid == pid && _message == message) return;
        _state = state; _pid = pid; _message = message;
        Log.Info(state switch
        {
            "waiting" => $"Waiting for {_processName}.exe …",
            "capturing" when pid == null => $"Streaming {message}.",
            "capturing" => $"Listening to {_processName}.exe (PID {pid}).",
            _ => $"{state}: {message}",
        });
        server.BroadcastText(StatusJson());
    }

    // ── Windows: watch for the game and capture only its audio ──
    private static void RunProcessWatcher(AudioPipeline pipeline, WsServer server, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var proc = Process.GetProcessesByName(_processName).OrderBy(p => p.StartTime).FirstOrDefault();
            if (proc == null)
            {
                SetStatus(server, "waiting");
                ct.WaitHandle.WaitOne(1500);
                continue;
            }

            using var capture = new ProcessLoopbackCapture((uint)proc.Id);
            var stopped = new ManualResetEventSlim(false);
            Exception? captureError = null;
            capture.DataAvailable += buf => pipeline.PushInterleaved(buf, ProcessLoopbackCapture.Channels);
            capture.Stopped += ex => { captureError = ex; stopped.Set(); };
            try
            {
                capture.Start();
                SetStatus(server, "capturing", proc.Id);
            }
            catch (Exception ex)
            {
                SetStatus(server, "error", proc.Id, $"Process-loopback capture failed ({ex.Message}). Needs Windows 10 build 20348+ or Windows 11.");
                ct.WaitHandle.WaitOne(10000);
                continue;
            }

            // Stay attached until the game exits, the capture dies, or we're asked to quit.
            while (!ct.IsCancellationRequested && !stopped.IsSet)
            {
                try { if (proc.HasExited) break; } catch { break; }
                WaitHandle.WaitAny(new[] { ct.WaitHandle, stopped.WaitHandle }, 1000);
            }
            capture.Stop();
            if (captureError != null) SetStatus(server, "error", proc.Id, "Capture stopped: " + captureError.Message);
            ct.WaitHandle.WaitOne(1000);
        }
    }

    // ── Any OS: stream a WAV file in real time (testing / tuning) ──
    private static void RunWav(string path, bool loop, AudioPipeline pipeline, WsServer server, CancellationToken ct)
    {
        var (samples48, channels) = Wav.ReadAs48k(path);
        Log.Info($"WAV: {path} — {samples48.Length / channels / 48000.0:F1}s, {channels}ch{(loop ? ", looping" : "")}");
        do
        {
            SetStatus(server, "capturing", null, "wav:" + Path.GetFileName(path));
            const int chunkFrames = 480; // 10 ms
            var sw = Stopwatch.StartNew();
            long sent = 0;
            for (int f = 0; f < samples48.Length / channels && !ct.IsCancellationRequested; f += chunkFrames)
            {
                int n = Math.Min(chunkFrames, samples48.Length / channels - f);
                var chunk = new float[n * channels];
                Array.Copy(samples48, f * channels, chunk, 0, chunk.Length);
                pipeline.PushInterleaved(chunk, channels);
                sent += n;
                long aheadMs = sent * 1000 / 48000 - sw.ElapsedMilliseconds;
                if (aheadMs > 0) Thread.Sleep((int)aheadMs);
            }
        } while (loop && !ct.IsCancellationRequested);
        SetStatus(server, "waiting", null, "wav finished");
        ct.WaitHandle.WaitOne(1500); // let clients drain
    }

    private static void PrintHelp() => Console.WriteLine(
        "PhasmListener — captures only Phasmophobia's audio for the Phasmo Journal footstep detector\n" +
        "  --port N             WebSocket port (default 47213)\n" +
        "  --process NAME       process to capture (default Phasmophobia)\n" +
        "  --allow-origin URL   extra site allowed to connect (rayzold.github.io and localhost are built in)\n" +
        "  --any-origin         allow every site (not recommended)\n" +
        "  --wav FILE [--loop]  stream a WAV file instead of the game (testing)");
}

internal static class Wav
{
    /// <summary>Reads PCM16 / float32 WAV, returns interleaved float at 48 kHz (linear resample if needed).</summary>
    public static (float[] data, int channels) ReadAs48k(string path)
    {
        using var br = new BinaryReader(File.OpenRead(path));
        if (new string(br.ReadChars(4)) != "RIFF") throw new InvalidDataException("not RIFF");
        br.ReadUInt32();
        if (new string(br.ReadChars(4)) != "WAVE") throw new InvalidDataException("not WAVE");
        int fmtTag = 0, ch = 0, rate = 0, bits = 0;
        byte[]? raw = null;
        while (br.BaseStream.Position + 8 <= br.BaseStream.Length)
        {
            string id = new(br.ReadChars(4));
            int size = br.ReadInt32();
            if (id == "fmt ")
            {
                fmtTag = br.ReadUInt16(); ch = br.ReadUInt16(); rate = br.ReadInt32();
                br.ReadInt32(); br.ReadUInt16(); bits = br.ReadUInt16();
                br.BaseStream.Seek(size - 16, SeekOrigin.Current);
            }
            else if (id == "data") { raw = br.ReadBytes(size); break; }
            else br.BaseStream.Seek(size + (size & 1), SeekOrigin.Current);
        }
        if (raw == null || ch == 0) throw new InvalidDataException("no fmt/data chunk");
        if (fmtTag == 0xFFFE) fmtTag = bits == 32 ? 3 : 1; // WAVE_FORMAT_EXTENSIBLE: assume plain PCM/float

        float[] f;
        if (fmtTag == 1 && bits == 16) { f = new float[raw.Length / 2]; for (int i = 0; i < f.Length; i++) f[i] = BitConverter.ToInt16(raw, i * 2) / 32768f; }
        else if (fmtTag == 3 && bits == 32) { f = new float[raw.Length / 4]; Buffer.BlockCopy(raw, 0, f, 0, f.Length * 4); }
        else throw new InvalidDataException($"unsupported WAV (format {fmtTag}, {bits}-bit) — use 16-bit PCM or 32-bit float");

        if (rate == 48000) return (f, ch);
        int framesIn = f.Length / ch, framesOut = (int)((long)framesIn * 48000 / rate);
        var o = new float[framesOut * ch];
        for (int i = 0; i < framesOut; i++)
        {
            double pos = (double)i * rate / 48000; int lo = (int)pos; int hi = Math.Min(lo + 1, framesIn - 1); double t = pos - lo;
            for (int c = 0; c < ch; c++) o[i * ch + c] = (float)(f[lo * ch + c] * (1 - t) + f[hi * ch + c] * t);
        }
        return (o, ch);
    }
}
