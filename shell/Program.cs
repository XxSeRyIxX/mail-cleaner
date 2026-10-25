// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Collections.Concurrent;
using System.Drawing;
using System.Net.Sockets;
using System.Text.Json;
using Photino.NET;

namespace MailCleaner;

/// <summary>
/// The desktop edition: the web app from app/ in the system's own webview (Photino), plus what a browser can't do:
/// IMAP, signing in through the user's browser, opening links outside and saving exports. The page asks for those
/// through the window's messages (app/native.js), which no other program or website can reach.
/// </summary>
internal static class Program
{
    private static readonly ConcurrentDictionary<string, CancellationTokenSource> Running = new();

    [STAThread]
    private static void Main(string[] args)
    {
        using Mutex instance = new(false, "MailCleaner");
        try
        {
            if (!instance.WaitOne(0)) return;
        }
        catch (AbandonedMutexException) { }

        try
        {
            RunWindow(args);
        }
        finally
        {
            instance.ReleaseMutex();
        }
    }

    private static void RunWindow(string[] args)
    {
        string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MailCleaner");
        PhotinoWindow window = new PhotinoWindow()
            // First: Photino logs every call and message unless told not to, and messages carry mail and sign-in tokens.
            .SetLogVerbosity(0)
            .SetTitle("Mail Cleaner")
            .SetUseOsDefaultSize(false)
            .SetSize(1280, 900)
            .SetMinSize(420, 480)
            .Center()
            .SetDevToolsEnabled(args.Contains("--dev"))
            // The app needs no camera, microphone or other permission: never grant one without asking.
            .SetGrantBrowserPermissions(false)
            .SetMediaStreamEnabled(false)
            // Its own WebView2 profile on Windows, instead of the one every Photino app shares.
            .SetTemporaryFilesPath(Path.Combine(data, "WebView2"));
        window.RegisterWindowCreatedHandler((_, _) => FitToScreen(window));

        // Windows answers the page's requests for http://127.0.0.1:5180 from memory, with no socket for antivirus or
        // ad-blocking software that filters local traffic to break. The webviews of macOS and Linux can't take over
        // http://, so there a loopback server answers.
        if (OperatingSystem.IsWindows()) window.RegisterCustomSchemeHandler("http", ServeEmbedded);

        using SignIn signIn = new();
        ImapStore store = new(data);
        ImapConnection connection = new(store);
        Commands commands = new(signIn, store, connection, new ImapBridge(connection));
        try
        {
            using SiteServer? server = OperatingSystem.IsWindows() ? null : new SiteServer();
            window.RegisterWebMessageReceivedHandler((sender, message) => OnMessage(window, commands, message));
            window.Load(new Uri(Site.Origin + "/"));
            window.WaitForClose();
        }
        catch (SocketException)
        {
            window.LoadRawString(LoopbackHttp.MessagePage(Texts.L("Mail Cleaner can't start", "Mail Cleaner no puede arrancar"),
                Texts.L($"Local port {Site.Port} is in use by another program.", $"El puerto local {Site.Port} lo está usando otro programa."),
                Texts.L("Close it, or an older Mail Cleaner that is still running, then open the app again. "
                    + "Your settings and your remove list have not been changed.",
                    "Ciérralo, o cierra un Mail Cleaner anterior que siga abierto, y vuelve a abrir la app. "
                    + "Tu configuración y tu lista para eliminar no han cambiado.")));
            window.WaitForClose();
        }
    }

    /// <summary>1280 by 900 at the screen's scale, but at most 90% of the main screen, and centered.</summary>
    private static void FitToScreen(PhotinoWindow window)
    {
        var monitors = window.Monitors;
        if (monitors.Count == 0) return;
        var screen = monitors.FirstOrDefault(m => m.MonitorArea.Location == Point.Empty, monitors[0]);
        // Windows sizes windows in physical pixels, macOS and Linux in scaled ones.
        double scale = OperatingSystem.IsWindows() ? screen.Scale : 1;
        window.SetSize((int)Math.Min(1280 * scale, screen.WorkArea.Width * 0.9), (int)Math.Min(900 * scale, screen.WorkArea.Height * 0.9));
        window.Center();
    }

    /// <summary>The app's own files; any other http:// request goes to the network as usual.</summary>
    private static Stream? ServeEmbedded(object sender, string scheme, string url, out string contentType)
    {
        contentType = "";
        if (!url.StartsWith(Site.Origin + "/", StringComparison.OrdinalIgnoreCase) || Site.Open(url[Site.Origin.Length..]) is not var (content, type))
            return null;
        contentType = type;
        return content;
    }

    /// <summary>Runs each request off the UI thread and answers with its id. "cancel" stops a running request.</summary>
    private static void OnMessage(PhotinoWindow window, Commands commands, string message)
    {
        Request? request;
        try
        {
            request = JsonSerializer.Deserialize(message, ShellJson.Default.Request);
        }
        catch (JsonException)
        {
            return;
        }
        if (request is null) return;

        if (request.Cmd == "cancel")
        {
            try
            {
                CancelRequest? cancel = request.Args.Deserialize(ShellJson.Default.CancelRequest);
                if (cancel is not null && Running.TryGetValue(cancel.Id, out CancellationTokenSource? running)) running.Cancel();
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException or ObjectDisposedException) { }
            return;
        }
        _ = Task.Run(() => AnswerAsync(window, commands, request));
    }

    private static async Task AnswerAsync(PhotinoWindow window, Commands commands, Request request)
    {
        using CancellationTokenSource cancel = new();
        if (!Running.TryAdd(request.Id, cancel)) return;
        Reply reply;
        try
        {
            reply = new Reply(request.Id, true, await commands.RunAsync(request.Cmd, request.Args, cancel.Token));
        }
        catch (Exception e)
        {
            (int status, string error) = Errors.Explain(e);
            reply = new Reply(request.Id, false, Status: status, Error: error);
        }
        finally
        {
            Running.TryRemove(request.Id, out _);
        }
        window.SendWebMessage(JsonSerializer.Serialize(reply, ShellJson.Default.Reply));
    }
}
