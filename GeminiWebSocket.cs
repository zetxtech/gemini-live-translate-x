using System;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MeetingTranslator;

public class GeminiWebSocket : IDisposable
{
    private const string Host = "generativelanguage.googleapis.com";
    private const string Path = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

    private readonly string _apiKey;
    private readonly string _model;
    private readonly string _targetLang;

    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private bool _connected;
    private int _chunkCount;

    public bool IsConnected => _connected;

    public event Action<string>? StatusChanged;
    public event Action<string>? InputTranscription;
    public event Action<string>? OutputTranscription;
    public event Action<byte[]>? AudioDataReceived;

    public GeminiWebSocket(string apiKey, string model = "gemini-3.5-live-translate-preview",
                           string targetLang = "zh-TW")
    {
        _apiKey = apiKey;
        _model = model;
        _targetLang = targetLang;
    }

    public async Task ConnectAsync()
    {
        if (_ws != null) return;

        _ws = new ClientWebSocket();
        _cts = new CancellationTokenSource();

        var uri = new Uri($"wss://{Host}{Path}?key={_apiKey}");
        NotifyStatus("Connecting...");

        try
        {
            await _ws.ConnectAsync(uri, _cts.Token);
            _ = Task.Run(ReceiveLoop);
            await SendSetupAsync();
        }
        catch (Exception ex)
        {
            NotifyStatus($"Connection failed: {ex.Message}");
            Cleanup();
        }
    }

    public void Disconnect()
    {
        _connected = false;
        Cleanup();
        NotifyStatus("Disconnected");
    }

    public async Task SendAudioAsync(byte[] pcm16)
    {
        if (!_connected || _ws == null || _ws.State != WebSocketState.Open) return;

        _chunkCount++;
        if (_chunkCount % 100 == 0)
        {
            var silent = pcm16.Length >= 200 && pcm16.AsSpan(0, 200).ToArray().All(b => b == 0);
            Console.WriteLine($"[WS] sent {_chunkCount} chunks | size={pcm16.Length} | silent={silent}");
        }

        var b64 = Convert.ToBase64String(pcm16);
        var msg = JsonSerializer.Serialize(new
        {
            realtimeInput = new
            {
                audio = new { data = b64, mimeType = "audio/pcm;rate=16000" }
            }
        });

        await SendAsync(msg);
    }

    public void Dispose()
    {
        _connected = false;
        Cleanup();
    }

    private async Task SendSetupAsync()
    {
        var isTranslate = _model.Contains("live-translate");

        object setup;
        if (isTranslate)
        {
            setup = new
            {
                setup = new
                {
                    model = $"models/{_model}",
                    inputAudioTranscription = new { },
                    outputAudioTranscription = new { },
                    generationConfig = new
                    {
                        responseModalities = new[] { "AUDIO" },
                        translationConfig = new
                        {
                            targetLanguageCode = _targetLang,
                            echoTargetLanguage = true
                        }
                    }
                }
            };
        }
        else
        {
            setup = new
            {
                setup = new
                {
                    model = $"models/{_model}",
                    generationConfig = new { responseModalities = new[] { "AUDIO" } },
                    systemInstruction = new
                    {
                        parts = new[]
                        {
                            new
                            {
                                text = "You are a professional real-time interpreter. " +
                                       "Listen to the input audio and translate it fluently " +
                                       "into Traditional Chinese (zh-TW)."
                            }
                        }
                    }
                }
            };
        }

        await SendAsync(JsonSerializer.Serialize(setup));
        NotifyStatus("Connecting...");
    }

    private async Task SendAsync(string json)
    {
        if (_ws == null || _ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(json);
        try
        {
            await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts!.Token);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WS] send error: {ex.Message}");
        }
    }

    private async Task ReceiveLoop()
    {
        var buffer = new byte[64 * 1024];
        var sb = new StringBuilder();

        try
        {
            while (_ws != null && _ws.State == WebSocketState.Open && !_cts!.IsCancellationRequested)
            {
                sb.Clear();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _connected = false;
                        NotifyStatus($"Disconnected ({result.CloseStatus})");
                        return;
                    }
                    sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                } while (!result.EndOfMessage);

                ProcessMessage(sb.ToString());
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException ex)
        {
            _connected = false;
            NotifyStatus($"WebSocket error: {ex.Message}");
        }
        catch (Exception ex)
        {
            _connected = false;
            Console.WriteLine($"[WS] receive error: {ex}");
        }
    }

    private void ProcessMessage(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.TryGetProperty("setupComplete", out _))
            {
                _connected = true;
                NotifyStatus("Connected - translating");
                return;
            }

            if (root.TryGetProperty("serverContent", out var sc))
            {
                ParseServerContent(sc);
                return;
            }

            if (root.TryGetProperty("error", out var err))
            {
                var msg = err.TryGetProperty("message", out var m) ? m.GetString() : err.ToString();
                Console.WriteLine($"[WS] server error: {msg}");
                NotifyStatus($"Error: {msg}");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WS] parse error: {ex.Message}");
        }
    }

    private void ParseServerContent(JsonElement sc)
    {
        if (sc.TryGetProperty("inputTranscription", out var it) &&
            it.TryGetProperty("text", out var itText))
        {
            var text = itText.GetString();
            if (!string.IsNullOrEmpty(text)) InputTranscription?.Invoke(text);
        }

        if (sc.TryGetProperty("outputTranscription", out var ot) &&
            ot.TryGetProperty("text", out var otText))
        {
            var text = otText.GetString();
            if (!string.IsNullOrEmpty(text)) OutputTranscription?.Invoke(text);
        }

        if (sc.TryGetProperty("modelTurn", out var mt) &&
            mt.TryGetProperty("parts", out var parts))
        {
            foreach (var part in parts.EnumerateArray())
            {
                if (part.TryGetProperty("inlineData", out var id))
                {
                    var mime = id.TryGetProperty("mimeType", out var m) ? m.GetString() : "";
                    if (mime?.StartsWith("audio/pcm") == true &&
                        id.TryGetProperty("data", out var d))
                    {
                        var audio = Convert.FromBase64String(d.GetString()!);
                        AudioDataReceived?.Invoke(audio);
                    }
                }

                if (part.TryGetProperty("text", out var t))
                {
                    var text = t.GetString();
                    if (!string.IsNullOrEmpty(text)) OutputTranscription?.Invoke(text);
                }
            }
        }
    }

    private void NotifyStatus(string status) => StatusChanged?.Invoke(status);

    private void Cleanup()
    {
        try { _cts?.Cancel(); } catch { }
        try { _ws?.Dispose(); } catch { }
        _ws = null;
        _cts = null;
    }
}
