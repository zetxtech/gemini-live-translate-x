using System;
using System.Collections.Generic;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace MeetingTranslator;

public class AudioDevice
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public int SampleRate { get; init; }
    public int Channels { get; init; }

    public override string ToString() => Name;
}

public class AudioCaptureManager : IDisposable
{
    private const int TargetRate = 16000;

    private WasapiLoopbackCapture? _capture;
    private bool _capturing;
    private readonly Queue<byte[]> _queue = new();
    private readonly object _lock = new();
    private Thread? _processThread;
    private volatile bool _running;
    private Action<byte[]>? _callback;

    public static List<AudioDevice> GetLoopbackDevices()
    {
        var devices = new List<AudioDevice>();
        var enumerator = new MMDeviceEnumerator();

        try
        {
            var render = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var wf = render.AudioClient.MixFormat;
            devices.Add(new AudioDevice
            {
                Id = render.ID,
                Name = $"[System Default] {render.FriendlyName}",
                SampleRate = wf.SampleRate,
                Channels = wf.Channels
            });
        }
        catch { }

        try
        {
            foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                var wf = device.AudioClient.MixFormat;
                devices.Add(new AudioDevice
                {
                    Id = device.ID,
                    Name = device.FriendlyName,
                    SampleRate = wf.SampleRate,
                    Channels = wf.Channels
                });
            }
        }
        catch { }

        return devices;
    }

    public void Start(AudioDevice device, Action<byte[]> callback)
    {
        if (_capturing) return;
        _callback = callback;

        var enumerator = new MMDeviceEnumerator();
        MMDevice? mmDevice = null;

        try
        {
            mmDevice = enumerator.GetDevice(device.Id);
        }
        catch
        {
            try
            {
                mmDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            }
            catch
            {
                throw new InvalidOperationException("No audio device available");
            }
        }

        _capture = new WasapiLoopbackCapture(mmDevice);
        _capture.DataAvailable += OnDataAvailable;
        _capture.RecordingStopped += OnRecordingStopped;
        _capture.StartRecording();
        _capturing = true;

        _running = true;
        _processThread = new Thread(ProcessLoop) { IsBackground = true };
        _processThread.Start();
    }

    public void Stop()
    {
        _running = false;
        _capturing = false;

        if (_capture != null)
        {
            try { _capture.StopRecording(); } catch { }
            _capture.DataAvailable -= OnDataAvailable;
            _capture.RecordingStopped -= OnRecordingStopped;
            _capture.Dispose();
            _capture = null;
        }

        lock (_lock)
        {
            _queue.Clear();
        }

        _callback = null;
    }

    public void Dispose() => Stop();

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded == 0) return;

        var data = new byte[e.BytesRecorded];
        Buffer.BlockCopy(e.Buffer, 0, data, 0, e.BytesRecorded);

        lock (_lock)
        {
            if (_queue.Count < 50)
                _queue.Enqueue(data);
        }
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        if (e.Exception != null)
            Console.WriteLine($"[Capture] Error: {e.Exception.Message}");
    }

    private void ProcessLoop()
    {
        while (_running)
        {
            byte[]? chunk = null;
            lock (_lock)
            {
                if (_queue.Count > 0)
                    chunk = _queue.Dequeue();
            }

            if (chunk == null)
            {
                Thread.Sleep(10);
                continue;
            }

            try
            {
                var format = _capture?.WaveFormat;
                if (format == null) continue;

                var pcm16 = ResampleToPcm16(chunk, format.SampleRate, format.Channels);
                _callback?.Invoke(pcm16);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Capture] process error: {ex.Message}");
            }
        }
    }

    private static byte[] ResampleToPcm16(byte[] input, int srcRate, int srcChannels)
    {
        var isIeee = srcRate > 0;

        float[] samples;
        if (input.Length % 4 == 0)
        {
            var floatCount = input.Length / 4;
            samples = new float[floatCount];
            Buffer.BlockCopy(input, 0, samples, 0, input.Length);
        }
        else
        {
            var shortCount = input.Length / 2;
            var temp = new short[shortCount];
            Buffer.BlockCopy(input, 0, temp, 0, input.Length);
            samples = new float[shortCount];
            for (int i = 0; i < shortCount; i++)
                samples[i] = temp[i] / 32768f;
        }

        if (srcChannels > 1)
        {
            var frameCount = samples.Length / srcChannels;
            var mono = new float[frameCount];
            for (int f = 0; f < frameCount; f++)
            {
                float sum = 0;
                for (int c = 0; c < srcChannels; c++)
                    sum += samples[f * srcChannels + c];
                mono[f] = sum / srcChannels;
            }
            samples = mono;
        }

        if (srcRate != TargetRate && srcRate > 0)
        {
            var ratio = (double)TargetRate / srcRate;
            var newLen = (int)(samples.Length * ratio);
            if (newLen > 0)
            {
                var resampled = new float[newLen];
                for (int i = 0; i < newLen; i++)
                {
                    var srcPos = i / ratio;
                    var idx = (int)srcPos;
                    var frac = (float)(srcPos - idx);
                    if (idx + 1 < samples.Length)
                        resampled[i] = samples[idx] * (1 - frac) + samples[idx + 1] * frac;
                    else if (idx < samples.Length)
                        resampled[i] = samples[idx];
                }
                samples = resampled;
            }
        }

        var pcm = new byte[samples.Length * 2];
        for (int i = 0; i < samples.Length; i++)
        {
            var val = (int)(Math.Clamp(samples[i], -1f, 1f) * 32767f);
            pcm[i * 2] = (byte)(val & 0xFF);
            pcm[i * 2 + 1] = (byte)((val >> 8) & 0xFF);
        }
        return pcm;
    }
}
