using System;
using System.IO;
using NAudio.Wave;

namespace MeetingTranslator;

public class AudioPlaybackManager : IDisposable
{
    private const int SampleRate = 24000;
    private const int Channels = 1;

    private WaveOutEvent? _player;
    private MemoryStream? _stream;
    private RawSourceWaveStream? _rawSource;
    private readonly object _lock = new();
    private bool _playing;

    public void Play(byte[] pcm16)
    {
        if (pcm16.Length == 0) return;

        lock (_lock)
        {
            try
            {
                if (_player == null)
                {
                    _stream = new MemoryStream();
                    _rawSource = new RawSourceWaveStream(_stream,
                        new WaveFormat(SampleRate, 16, Channels));
                    _player = new WaveOutEvent { DesiredLatency = 100 };
                    _player.Init(_rawSource);
                    _player.PlaybackStopped += OnPlaybackStopped;
                }

                _stream!.Position = _stream.Length;
                _stream.Write(pcm16, 0, pcm16.Length);
                _stream.Position = 0;

                if (!_playing)
                {
                    _player.Play();
                    _playing = true;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Playback] {ex.Message}");
                CleanupPlayer();
            }
        }
    }

    public void Stop()
    {
        lock (_lock)
        {
            _playing = false;
            CleanupPlayer();
        }
    }

    public void Dispose() => Stop();

    private void OnPlaybackStopped(object? sender, StoppedEventArgs e)
    {
        lock (_lock)
        {
            _playing = false;
            if (e.Exception != null)
                Console.WriteLine($"[Playback] stopped with error: {e.Exception.Message}");
        }
    }

    private void CleanupPlayer()
    {
        try { _player?.Stop(); } catch { }
        try { _player?.Dispose(); } catch { }
        try { _rawSource?.Dispose(); } catch { }
        try { _stream?.Dispose(); } catch { }
        _player = null;
        _rawSource = null;
        _stream = null;
    }
}
