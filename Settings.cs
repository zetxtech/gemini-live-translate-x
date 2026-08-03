using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MeetingTranslator;

public class Settings
{
    private static readonly string ConfigPath = Path.Combine(
        AppContext.BaseDirectory, "settings.json");

    [JsonPropertyName("api_key")]    public string ApiKey { get; set; } = "";
    [JsonPropertyName("model")]      public string Model { get; set; } = "gemini-3.5-live-translate-preview";
    [JsonPropertyName("show_bilingual")] public bool ShowBilingual { get; set; } = true;
    [JsonPropertyName("enable_voice")]   public bool EnableVoice { get; set; } = true;
    [JsonPropertyName("audio_device_id")] public string? AudioDeviceId { get; set; }

    public static Settings Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                return JsonSerializer.Deserialize<Settings>(json) ?? new Settings();
            }
        }
        catch { }
        return new Settings();
    }

    public void Save()
    {
        try
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json);
        }
        catch { }
    }
}
