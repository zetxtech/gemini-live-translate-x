using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace MeetingTranslator;

public partial class MainWindow : Window
{
    // ── Colors ────────────────────────────────────────────────────────────────
    private static readonly SolidColorBrush AccentBrush = new(Color.FromRgb(0x9b, 0x82, 0xfd));
    private static readonly SolidColorBrush GreenBrush   = new(Color.FromRgb(0x22, 0xc5, 0x5e));
    private static readonly SolidColorBrush GrayBrush    = new(Color.FromRgb(0x71, 0x71, 0x7a));
    private static readonly SolidColorBrush WhiteBrush   = new(Color.FromRgb(0xe4, 0xe4, 0xe7));
    private static readonly SolidColorBrush OrigBrush    = new(Color.FromRgb(0xa1, 0xa1, 0xaa));
    private static readonly SolidColorBrush CurrentOrigBrush = new(Color.FromRgb(0x9b, 0x82, 0xfd));
    private static readonly SolidColorBrush CurrentTransBrush = Brushes.White;

    static MainWindow()
    {
        AccentBrush.Freeze(); GreenBrush.Freeze(); GrayBrush.Freeze();
        WhiteBrush.Freeze(); OrigBrush.Freeze(); CurrentOrigBrush.Freeze();
    }

    // ── State ─────────────────────────────────────────────────────────────────
    private readonly Settings _settings;
    private GeminiWebSocket? _gemini;
    private readonly AudioCaptureManager _capture = new();
    private readonly AudioPlaybackManager _player = new();
    private List<AudioDevice> _devices = new();
    private readonly List<(string orig, string trans)> _history = new();
    private string _curOrig = "", _curTrans = "";
    private bool _keyVisible;

    public MainWindow()
    {
        InitializeComponent();
        _settings = Settings.Load();
        RestoreSettings();
        RefreshDevices();
        Closing += (_, _) => { StopTranslation(); _player.Dispose(); _capture.Dispose(); };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  WINDOW CHROME
    // ═══════════════════════════════════════════════════════════════════════════

    private void Minimize_Click(object sender, RoutedEventArgs e) =>
        WindowState = WindowState.Minimized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    // ═══════════════════════════════════════════════════════════════════════════
    //  UI EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    private void ToggleKeyVisibility_Click(object sender, RoutedEventArgs e)
    {
        _keyVisible = !_keyVisible;
        ApiEntry.FontFamily = _keyVisible ? new FontFamily("Consolas") : new FontFamily("Consolas");
        // WPF doesn't have UseSystemPasswordChar; we toggle via a custom approach
        if (_keyVisible)
        {
            ApiEntry.Text = ApiEntry.Text; // force refresh
            // We need to temporarily change the template - simplest: just show the text
            // For WPF, we use PasswordBox or a custom approach. Here we use a workaround:
            var pwd = ApiEntry.Text;
            ApiEntry.Text = pwd;
        }
    }

    private void ApiEntry_GotFocus(object sender, RoutedEventArgs e)
    {
        // Placeholder behavior
    }

    private void ApiEntry_LostFocus(object sender, RoutedEventArgs e)
    {
        // Placeholder behavior
    }

    private void ModelPreset_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button btn)
            ModelEntry.Text = btn.Content.ToString();
    }

    private void RefreshDevices_Click(object sender, RoutedEventArgs e) => RefreshDevices();

    private async void Start_Click(object sender, RoutedEventArgs e)
    {
        var apiKey = ApiEntry.Text.Trim();
        if (string.IsNullOrEmpty(apiKey))
        {
            SetStatus("Error: enter API key first", new SolidColorBrush(Color.FromRgb(0xef, 0x44, 0x44)));
            return;
        }

        if (DeviceCombo.SelectedItem is not AudioDevice device)
        {
            SetStatus("Error: select audio device", new SolidColorBrush(Color.FromRgb(0xef, 0x44, 0x44)));
            return;
        }

        var model = ModelEntry.Text.Trim();
        if (string.IsNullOrEmpty(model)) model = "gemini-3.5-live-translate-preview";

        SaveSettings();

        StartBtn.Visibility = Visibility.Collapsed;
        StopBtn.Visibility = Visibility.Visible;
        ApiEntry.IsEnabled = false;
        ModelEntry.IsEnabled = false;
        DeviceCombo.IsEnabled = false;

        _history.Clear();
        _curOrig = "";
        _curTrans = "";
        RenderSubtitles();

        _gemini = new GeminiWebSocket(apiKey, model);
        _gemini.StatusChanged += s => Dispatcher.BeginInvoke(() => OnGeminiStatus(s));
        _gemini.InputTranscription += t => Dispatcher.BeginInvoke(() => OnInputText(t));
        _gemini.OutputTranscription += t => Dispatcher.BeginInvoke(() => OnOutputText(t));
        _gemini.AudioDataReceived += d => { if (VoiceCheck.IsChecked == true) _player.Play(d); };
        await _gemini.ConnectAsync();

        try
        {
            _capture.Start(device, data =>
            {
                if (_gemini?.IsConnected == true)
                    _ = _gemini.SendAudioAsync(data);
            });
        }
        catch (Exception ex)
        {
            SetStatus($"Audio error: {ex.Message}", new SolidColorBrush(Color.FromRgb(0xef, 0x44, 0x44)));
            StopTranslation();
            return;
        }

        SetStatus("Connecting...", AccentBrush);
    }

    private void Stop_Click(object sender, RoutedEventArgs e) => StopTranslation();

    // ═══════════════════════════════════════════════════════════════════════════
    //  CORE LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    private void RefreshDevices()
    {
        _devices = AudioCaptureManager.GetLoopbackDevices();
        DeviceCombo.ItemsSource = _devices;

        if (_devices.Count > 0)
        {
            var saved = _devices.FindIndex(d => d.Id == _settings.AudioDeviceId);
            DeviceCombo.SelectedIndex = saved >= 0 ? saved : 0;
        }
    }

    private void StopTranslation()
    {
        _capture.Stop();
        _player.Stop();
        _gemini?.Dispose();
        _gemini = null;

        StopBtn.Visibility = Visibility.Collapsed;
        StartBtn.Visibility = Visibility.Visible;
        ApiEntry.IsEnabled = true;
        ModelEntry.IsEnabled = true;
        DeviceCombo.IsEnabled = true;
        SetStatus("Stopped", GrayBrush);
    }

    private void OnGeminiStatus(string status)
    {
        var brush = status.Contains("Connected") || status.Contains("translat") ? GreenBrush : GrayBrush;
        SetStatus(status, brush);
    }

    private void OnInputText(string text)
    {
        _curOrig += text;
        CheckSentenceEnd(text);
        RenderSubtitles();
    }

    private void OnOutputText(string text)
    {
        _curTrans += text;
        CheckSentenceEnd(text);
        RenderSubtitles();
    }

    private void CheckSentenceEnd(string text)
    {
        foreach (var c in new[] { "。", "？", "！", ".", "?", "!", "\n" })
        {
            if (text.Contains(c))
            {
                if (!string.IsNullOrEmpty(_curOrig) || !string.IsNullOrEmpty(_curTrans))
                {
                    _history.Add((_curOrig, _curTrans));
                    _curOrig = "";
                    _curTrans = "";
                    if (_history.Count > 50) _history.RemoveAt(0);
                }
                return;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SUBTITLE RENDERING
    // ═══════════════════════════════════════════════════════════════════════════

    private void RenderSubtitles()
    {
        SubtitleBox.Document.Blocks.Clear();
        var para = new Paragraph { LineHeight = 24 };

        var start = Math.Max(0, _history.Count - 30);
        for (int i = start; i < _history.Count; i++)
        {
            var (orig, trans) = _history[i];
            if (BilingualCheck.IsChecked == true && !string.IsNullOrEmpty(orig))
                para.Inlines.Add(new Run(orig + "\n")
                {
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 11,
                    Foreground = OrigBrush
                });
            if (!string.IsNullOrEmpty(trans))
                para.Inlines.Add(new Run(trans + "\n")
                {
                    FontSize = 13,
                    Foreground = WhiteBrush
                });
            para.Inlines.Add(new LineBreak());
        }

        // Current line
        if (BilingualCheck.IsChecked == true && !string.IsNullOrEmpty(_curOrig))
            para.Inlines.Add(new Run(_curOrig + "\n")
            {
                FontFamily = new FontFamily("Consolas"),
                FontSize = 11.5,
                Foreground = CurrentOrigBrush
            });
        if (!string.IsNullOrEmpty(_curTrans))
            para.Inlines.Add(new Run(_curTrans)
            {
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = CurrentTransBrush
            });

        // Placeholder
        if (_history.Count == 0 && string.IsNullOrEmpty(_curOrig) && string.IsNullOrEmpty(_curTrans))
            para.Inlines.Add(new Run("Waiting for audio input...\nSelect an audio source and press Start.")
            {
                FontSize = 12,
                Foreground = GrayBrush
            });

        SubtitleBox.Document.Blocks.Add(para);
        SubtitleBox.ScrollToEnd();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  SETTINGS
    // ═══════════════════════════════════════════════════════════════════════════

    private void RestoreSettings()
    {
        if (!string.IsNullOrEmpty(_settings.ApiKey))
            ApiEntry.Text = _settings.ApiKey;
        ModelEntry.Text = _settings.Model ?? "gemini-3.5-live-translate-preview";
        BilingualCheck.IsChecked = _settings.ShowBilingual;
        VoiceCheck.IsChecked = _settings.EnableVoice;
    }

    private void SaveSettings()
    {
        _settings.ApiKey = ApiEntry.Text.Trim();
        _settings.Model = ModelEntry.Text.Trim();
        _settings.ShowBilingual = BilingualCheck.IsChecked == true;
        _settings.EnableVoice = VoiceCheck.IsChecked == true;
        if (DeviceCombo.SelectedItem is AudioDevice dev)
            _settings.AudioDeviceId = dev.Id;
        _settings.Save();
    }

    private void SetStatus(string text, Brush brush)
    {
        StatusText.Text = text;
        StatusText.Foreground = brush;
    }
}
