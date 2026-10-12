// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace MailCleaner;

/// <summary>What a page can't do inside the webview: open links in the user's own browser, and save downloads.</summary>
internal static partial class Desktop
{
    /// <summary>Opens a web or mailto link in the user's browser or mail app.</summary>
    public static void Open(string url) =>
        OpenBrowser((SafeLink(url) ?? throw new ApiException(400, "Mail Cleaner only opens web and email links.")).AbsoluteUri);

    /// <summary>Web and mailto links only: any other scheme could start a program on this computer.</summary>
    internal static Uri? SafeLink(string? url) =>
        url is { Length: > 0 and <= 8192 } && !url.Any(char.IsControl)
        && Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) && uri.Scheme is "https" or "http" or "mailto" ? uri : null;

    internal static void OpenBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();
        }
        catch (Win32Exception e)
        {
            throw new ApiException(500, $"Couldn't open your browser: {e.Message}");
        }
    }

    /// <summary>Saves an export to the Downloads folder, as a browser would, next to any file of the same name.</summary>
    public static Saved Save(SaveRequest req)
    {
        string name = SafeFileName(req.Name) ?? throw new ApiException(400, "That file name isn't allowed.");
        string folder = DownloadsFolder();
        byte[] bytes = new UTF8Encoding(false).GetBytes(req.Text);
        for (int n = 0; ; n++)
        {
            string path = Path.Combine(folder, n == 0 ? name : $"{Path.GetFileNameWithoutExtension(name)} ({n}){Path.GetExtension(name)}");
            try
            {
                using FileStream file = new(path, FileMode.CreateNew, FileAccess.Write);
                file.Write(bytes);
                return new Saved(path);
            }
            catch (IOException) when (n < 100 && File.Exists(path)) { }
        }
    }

    /// <summary>The page's export names: plain text formats only, never a path or a program.</summary>
    internal static string? SafeFileName(string? name) => name is { Length: <= 120 } && ExportName().IsMatch(name) ? name : null;

    private static string DownloadsFolder()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string downloads = Path.Combine(home, "Downloads");
        return Directory.Exists(downloads) ? downloads : home;
    }

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]*\.(csv|md|txt)$")]
    private static partial Regex ExportName();
}
