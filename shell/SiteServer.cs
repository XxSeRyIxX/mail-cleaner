// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Net;
using System.Net.Sockets;
using System.Reflection;

namespace MailCleaner;

/// <summary>The web app (app/), embedded in the executable, at http://127.0.0.1:5180/.</summary>
internal static class Site
{
    /// <summary>The page keeps its settings and remove list per origin, so the address never changes.</summary>
    internal const int Port = 5180;
    internal const string Origin = "http://127.0.0.1:5180";
    private const string Prefix = "site.";

    private static readonly Assembly Assembly = typeof(Site).Assembly;

    // RecursiveDir leaves Windows separators in the resource name; the URLs that ask for them always use the other kind.
    private static readonly Dictionary<string, string> Files = Assembly.GetManifestResourceNames()
        .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal))
        .ToDictionary(n => n[Prefix.Length..].Replace('\\', '/'), n => n);

    /// <summary>The embedded file for a request target such as "/app.js?v=1", or null. Exact names only, so "../" can't escape.</summary>
    internal static (Stream Content, string Type)? Open(string target)
    {
        string name = Uri.UnescapeDataString(target.Split('?', 2)[0].Split('#', 2)[0]).TrimStart('/');
        if (name.Length == 0) name = "index.html";
        return Files.TryGetValue(name, out string? resource) && Assembly.GetManifestResourceStream(resource) is { } content
            ? (content, ContentType(name))
            : null;
    }

    private static string ContentType(string name) => Path.GetExtension(name) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".json" => "application/json",
        ".png" => "image/png",
        ".svg" => "image/svg+xml",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
}

/// <summary>
/// Serves the embedded web app over loopback on macOS and Linux, whose webviews can't take over http:// requests.
/// Real HTTP keeps modules, fetch() and relative URLs working exactly as on the website. It only serves those files:
/// everything else goes through the window's messages, which no other program or website can reach.
/// </summary>
internal sealed class SiteServer : IDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, Site.Port);
    private readonly CancellationTokenSource _stopping = new();

    public SiteServer()
    {
        try
        {
            _listener.Start();
        }
        catch (SocketException)
        {
            _listener.Stop();
            throw;
        }
        _ = LoopbackHttp.ServeAsync(_listener, RespondAsync, _stopping.Token);
    }

    private static async Task RespondAsync(string target, Stream stream)
    {
        if (Site.Open(target) is not var (content, type))
        {
            await LoopbackHttp.NotFoundAsync(stream);
            return;
        }
        using (content)
        {
            using MemoryStream body = new();
            await content.CopyToAsync(body);
            await LoopbackHttp.WriteAsync(stream, "200 OK", type, body.ToArray());
        }
    }

    public void Dispose()
    {
        _stopping.Cancel();
        _listener.Stop();
        _stopping.Dispose();
    }
}
