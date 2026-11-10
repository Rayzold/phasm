using System.Diagnostics;

namespace PhasmListener;

/// <summary>
/// 48 kHz interleaved stereo float → 16 kHz mono int16, with a windowed-sinc anti-alias filter,
/// cut into 20 ms frames. Also keeps the output on a real-time clock: when the source goes
/// quiet (process loopback delivers nothing while the game renders nothing), it pads silence so
/// the browser's sample-count clock — which is what footstep intervals are measured with — never
/// stalls.
/// </summary>
internal sealed class AudioPipeline
{
    public const int OutRate = 16000;
    public const int FrameSamples = OutRate / 50; // 20 ms

    private const int InRate = 48000, Decim = InRate / OutRate; // 3
    private static readonly float[] Taps = BuildLowpass(63, 7000.0 / InRate);

    private readonly Action<byte[]> _emit;
    private readonly object _lock = new();
    private readonly float[] _hist = new float[Taps.Length];
    private int _histPos, _phase;
    private readonly short[] _frame = new short[FrameSamples];
    private int _frameFill;

    private readonly Stopwatch _clock = new();
    private long _lastDataMs;
    private long _emitted; // output samples emitted since (re)alignment
    private long _alignMs; // clock time that _emitted is counted from

    public AudioPipeline(Action<byte[]> emit) { _emit = emit; _clock.Start(); }

    /// <summary>Interleaved stereo (or mono when channels==1) float samples at 48 kHz.</summary>
    public void PushInterleaved(float[] data, int channels)
    {
        lock (_lock)
        {
            long now = _clock.ElapsedMilliseconds;
            if (now - _lastDataMs > 300) { _alignMs = now; _emitted = 0; } // resumed after a gap
            _lastDataMs = now;

            int frames = data.Length / channels;
            for (int i = 0; i < frames; i++)
            {
                float m = 0;
                for (int c = 0; c < channels; c++) m += data[i * channels + c];
                PushMono(m / channels);
            }
        }
    }

    /// <summary>Called ~every 50 ms: pads silence while the source is quiet.</summary>
    public void Tick()
    {
        lock (_lock)
        {
            long now = _clock.ElapsedMilliseconds;
            if (now - _lastDataMs <= 300) return;
            long due = (now - _alignMs) * OutRate / 1000;
            while (_emitted < due) PushOut(0f);
        }
    }

    private void PushMono(float x)
    {
        _hist[_histPos] = x;
        _histPos = (_histPos + 1) % _hist.Length;
        if (++_phase < Decim) return;
        _phase = 0;
        float acc = 0;
        int idx = _histPos;
        for (int k = 0; k < Taps.Length; k++)
        {
            acc += Taps[k] * _hist[idx];
            idx = (idx + 1) % _hist.Length;
        }
        PushOut(acc);
    }

    private void PushOut(float s)
    {
        _emitted++;
        float c = Math.Clamp(s, -1f, 1f);
        _frame[_frameFill++] = (short)Math.Round(c * 32767f);
        if (_frameFill < FrameSamples) return;
        var bytes = new byte[FrameSamples * 2];
        Buffer.BlockCopy(_frame, 0, bytes, 0, bytes.Length); // little-endian on x64/arm64
        _frameFill = 0;
        _emit(bytes);
    }

    private static float[] BuildLowpass(int n, double fc)
    {
        var h = new float[n];
        double sum = 0, mid = (n - 1) / 2.0;
        for (int i = 0; i < n; i++)
        {
            double t = i - mid;
            double sinc = t == 0 ? 2 * fc : Math.Sin(2 * Math.PI * fc * t) / (Math.PI * t);
            double w = 0.54 - 0.46 * Math.Cos(2 * Math.PI * i / (n - 1)); // Hamming
            h[i] = (float)(sinc * w);
            sum += h[i];
        }
        for (int i = 0; i < n; i++) h[i] = (float)(h[i] / sum);
        return h;
    }
}
