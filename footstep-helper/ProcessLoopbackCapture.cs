// Per-process WASAPI loopback capture (Windows 10 build 20348+ / Windows 11).
//
// Adapted from ProcessLoopbackCapture.cs in ilyasst/meeting-transcriber-win
// (MIT License, Copyright (c) 2026 ilyasst — see THIRD_PARTY_NOTICES.md), which in turn
// follows Microsoft's ApplicationLoopback C++ sample:
//   https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback
//
// Changes vs. the original: no NAudio dependency (raw float[] callback instead of
// WaveInEventArgs), and the capture reports how many frames it delivered so the caller can
// keep a real-time sample clock.

using System.Runtime.InteropServices;

namespace PhasmListener;

/// <summary>Captures only the audio rendered by one process (and its children).</summary>
internal sealed class ProcessLoopbackCapture : IDisposable
{
    public const int SampleRate = 48000;
    public const int Channels = 2;

    /// <summary>Interleaved float32 frames (SampleRate, Channels). Raised on the pump thread.</summary>
    public event Action<float[]>? DataAvailable;
    public event Action<Exception?>? Stopped;

    private readonly uint _processId;
    private IAudioClient? _audioClient;
    private IAudioCaptureClient? _captureClient;
    private IntPtr _eventHandle = IntPtr.Zero;
    private Thread? _pumpThread;
    private volatile bool _stopRequested;

    public ProcessLoopbackCapture(uint processId)
    {
        if (processId == 0) throw new ArgumentException("processId must be non-zero", nameof(processId));
        _processId = processId;
    }

    public void Start()
    {
        ActivateClient();
        InitializeClient();
        _stopRequested = false;
        _pumpThread = new Thread(PumpLoop) { IsBackground = true, Name = "PhasmListener.Loopback" };
        _pumpThread.Start();
        int hr = _audioClient!.Start();
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    public void Stop()
    {
        if (_stopRequested) return;
        _stopRequested = true;
        if (_eventHandle != IntPtr.Zero) NativeMethods.SetEvent(_eventHandle);
        try { _audioClient?.Stop(); } catch { /* best-effort */ }
        _pumpThread?.Join(2000);
    }

    public void Dispose()
    {
        try { Stop(); } catch { }
        if (_captureClient != null) { Marshal.ReleaseComObject(_captureClient); _captureClient = null; }
        if (_audioClient != null) { Marshal.ReleaseComObject(_audioClient); _audioClient = null; }
        if (_eventHandle != IntPtr.Zero) { NativeMethods.CloseHandle(_eventHandle); _eventHandle = IntPtr.Zero; }
    }

    // ── Step 1: ActivateAudioInterfaceAsync on the virtual process-loopback device ──
    private void ActivateClient()
    {
        var loopParams = new AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = AUDIOCLIENT_ACTIVATION_TYPE.PROCESS_LOOPBACK,
            ProcessLoopbackParams = new AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
            {
                TargetProcessId = _processId,
                ProcessLoopbackMode = PROCESS_LOOPBACK_MODE.INCLUDE_TARGET_PROCESS_TREE,
            },
        };

        int paramsSize = Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>();
        IntPtr paramsPtr = Marshal.AllocCoTaskMem(paramsSize);
        try
        {
            Marshal.StructureToPtr(loopParams, paramsPtr, false);
            var prop = new PROPVARIANT { vt = (ushort)VarEnum.VT_BLOB, blobSize = (uint)paramsSize, blobData = paramsPtr };

            var handler = new ActivationHandler();
            int hr = NativeMethods.ActivateAudioInterfaceAsync(
                NativeMethods.VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                NativeMethods.IID_IAudioClient, ref prop, handler,
                out IActivateAudioInterfaceAsyncOperation op);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);

            if (!handler.Wait(TimeSpan.FromSeconds(5)))
                throw new TimeoutException("Process-loopback activation did not complete within 5s.");
            op.GetActivateResult(out int activateHr, out object activated);
            if (activateHr < 0) Marshal.ThrowExceptionForHR(activateHr);
            _audioClient = (IAudioClient)activated;
        }
        finally
        {
            Marshal.FreeCoTaskMem(paramsPtr);
        }
    }

    // ── Step 2: Initialize in shared, loopback, event-driven mode (float32 48k stereo) ──
    private void InitializeClient()
    {
        if (_audioClient == null) throw new InvalidOperationException("audio client not activated");

        var fmt = new WAVEFORMATEX
        {
            wFormatTag = 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels = Channels,
            nSamplesPerSec = SampleRate,
            wBitsPerSample = 32,
            nBlockAlign = Channels * 4,
            nAvgBytesPerSec = SampleRate * Channels * 4,
            cbSize = 0,
        };

        IntPtr fmtPtr = Marshal.AllocCoTaskMem(Marshal.SizeOf<WAVEFORMATEX>());
        try
        {
            Marshal.StructureToPtr(fmt, fmtPtr, false);
            const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
            const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
            const long bufferDuration100Ns = 200_0000; // 200 ms
            int hr = _audioClient.Initialize(AUDCLNT_SHAREMODE.SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                bufferDuration100Ns, 0, fmtPtr, Guid.Empty);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        }
        finally
        {
            Marshal.FreeCoTaskMem(fmtPtr);
        }

        _eventHandle = NativeMethods.CreateEvent(IntPtr.Zero, false, false, null);
        if (_eventHandle == IntPtr.Zero) throw new InvalidOperationException("CreateEvent failed");
        int eh = _audioClient.SetEventHandle(_eventHandle);
        if (eh < 0) Marshal.ThrowExceptionForHR(eh);

        Guid iid = NativeMethods.IID_IAudioCaptureClient;
        int gh = _audioClient.GetService(ref iid, out object svc);
        if (gh < 0) Marshal.ThrowExceptionForHR(gh);
        _captureClient = (IAudioCaptureClient)svc;
    }

    // ── Step 3: Pump loop ──
    private void PumpLoop()
    {
        Exception? error = null;
        try
        {
            while (!_stopRequested)
            {
                NativeMethods.WaitForSingleObject(_eventHandle, 1000);
                if (_stopRequested) break;
                Drain();
            }
        }
        catch (Exception ex) { error = ex; }
        Stopped?.Invoke(error);
    }

    private void Drain()
    {
        if (_captureClient == null) return;
        while (true)
        {
            int hr = _captureClient.GetNextPacketSize(out uint next);
            if (hr < 0) throw Marshal.GetExceptionForHR(hr)!;
            if (next == 0) return;

            hr = _captureClient.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _);
            if (hr < 0) throw Marshal.GetExceptionForHR(hr)!;
            try
            {
                int count = (int)frames * Channels;
                if (count > 0)
                {
                    var buf = new float[count];
                    // AUDCLNT_BUFFERFLAGS_SILENT (0x2): implicit silence, keep zeros (time-aligned).
                    if ((flags & 0x2) == 0 && data != IntPtr.Zero) Marshal.Copy(data, buf, 0, count);
                    DataAvailable?.Invoke(buf);
                }
            }
            finally { _captureClient.ReleaseBuffer(frames); }
        }
    }

    // ── COM plumbing ──
    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComVisible(true)]
    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler
    {
        private readonly ManualResetEventSlim _done = new(false);
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { _done.Set(); return 0; }
        public bool Wait(TimeSpan timeout) => _done.Wait(timeout);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    private enum AUDCLNT_SHAREMODE { SHARED = 0, EXCLUSIVE = 1 }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(AUDCLNT_SHAREMODE shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, Guid audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long hnsLatency);
        [PreserveSig] int GetCurrentPadding(out uint paddingFrames);
        [PreserveSig] int IsFormatSupported(AUDCLNT_SHAREMODE shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    private enum AUDIOCLIENT_ACTIVATION_TYPE { DEFAULT = 0, PROCESS_LOOPBACK = 1 }
    private enum PROCESS_LOOPBACK_MODE { INCLUDE_TARGET_PROCESS_TREE = 0, EXCLUDE_TARGET_PROCESS_TREE = 1 }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { public uint TargetProcessId; public PROCESS_LOOPBACK_MODE ProcessLoopbackMode; }

    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_ACTIVATION_PARAMS { public AUDIOCLIENT_ACTIVATION_TYPE ActivationType; public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPVARIANT
    {
        public ushort vt, wReserved1, wReserved2, wReserved3;
        public uint blobSize;
        public IntPtr blobData;
        public ulong _pad;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag, nChannels;
        public uint nSamplesPerSec, nAvgBytesPerSec;
        public ushort nBlockAlign, wBitsPerSample, cbSize;
    }

    private static class NativeMethods
    {
        public const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
        public static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        public static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode, PreserveSig = true)]
        public static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid, ref PROPVARIANT activationParams,
            [MarshalAs(UnmanagedType.Interface)] IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateEvent(IntPtr lpEventAttributes, [MarshalAs(UnmanagedType.Bool)] bool bManualReset, [MarshalAs(UnmanagedType.Bool)] bool bInitialState, string? lpName);
        [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetEvent(IntPtr hEvent);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
        [DllImport("kernel32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr hObject);
    }
}
