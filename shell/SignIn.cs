// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Buffers.Text;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MailCleaner;

/// <summary>
/// Signing in to Microsoft and Google for the desktop edition. Both refuse sign-ins inside an embedded webview, so this
/// opens the user's own browser and listens on a loopback port for the answer (RFC 8252), with PKCE. Refresh tokens
/// stay here, in memory, until the app closes; the page only ever gets access tokens.
/// </summary>
internal sealed class SignIn : IDisposable
{
    /// <summary>
    /// Microsoft's way back: the app registration lists http://localhost/mail-cleaner under "Mobile and desktop
    /// applications", and Microsoft ignores the port of localhost addresses. The path keeps it apart from any
    /// single-page app address on localhost in the same registration. Google's Desktop app clients need nothing.
    /// </summary>
    internal const string MicrosoftPath = "/mail-cleaner";
    private const string MicrosoftScopes = "openid profile offline_access Mail.ReadWrite MailboxSettings.ReadWrite";
    private const string GoogleScopes = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic " +
                                        "https://www.googleapis.com/auth/drive.appdata";
    private static readonly TimeSpan Patience = TimeSpan.FromMinutes(10);

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Session> _sessions = [];
    private CancellationTokenSource? _waiting;

    private sealed record Session(string ClientId, string Tenant, string? Secret, string Refresh);

    /// <summary>Signs in in the browser. The answer is the provider's token answer without the refresh token, or its error.</summary>
    public async Task<JsonObject> SignInAsync(SignInRequest req, CancellationToken ct)
    {
        bool google = IsGoogle(req.Provider);
        if (string.IsNullOrWhiteSpace(req.ClientId))
            throw new ApiException(400, Texts.L("Set up the app registration first.", "Configura antes el registro de la app."));
        string tenant = TenantOf(req.Tenant);

        // One sign-in waits for the browser at a time: a new one replaces it.
        using CancellationTokenSource wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        wait.CancelAfter(Patience);
        CancellationTokenSource? previous;
        lock (_gate)
        {
            previous = _waiting;
            _waiting = wait;
        }
        try
        {
            previous?.Cancel();
        }
        catch (ObjectDisposedException) { }

        try
        {
            using LoopbackRedirect redirect = new(google ? "/" : MicrosoftPath);
            string redirectUri = google ? $"http://127.0.0.1:{redirect.Port}/" : $"http://localhost:{redirect.Port}{MicrosoftPath}";
            string verifier = RandomText(32);
            string state = RandomText(16);
            Dictionary<string, string> query = new()
            {
                ["client_id"] = req.ClientId,
                ["response_type"] = "code",
                ["redirect_uri"] = redirectUri,
                ["scope"] = google ? GoogleScopes : MicrosoftScopes,
                ["state"] = state,
                ["code_challenge"] = Challenge(verifier),
                ["code_challenge_method"] = "S256",
                ["prompt"] = "select_account",
            };
            Desktop.OpenBrowser((google ? "https://accounts.google.com/o/oauth2/v2/auth" : MicrosoftUrl(tenant, "authorize")) + "?" + Form(query));

            Dictionary<string, string> answer = await redirect.WaitAsync(state, wait.Token);
            if (answer.TryGetValue("error", out string? error))
                return new JsonObject { ["error"] = error, ["error_description"] = answer.GetValueOrDefault("error_description") };

            Dictionary<string, string> fields = new()
            {
                ["client_id"] = req.ClientId,
                ["grant_type"] = "authorization_code",
                ["code"] = answer.GetValueOrDefault("code") ?? "",
                ["redirect_uri"] = redirectUri,
                ["code_verifier"] = verifier,
            };
            if (!google) fields["scope"] = MicrosoftScopes;
            else if (!string.IsNullOrEmpty(req.Secret)) fields["client_secret"] = req.Secret;

            JsonObject token = await PostAsync(TokenUrl(google, tenant), fields, wait.Token);
            string? refresh = TakeRefresh(token);
            if (token["access_token"] is not null)
            {
                lock (_gate) _sessions[req.Provider] = new Session(req.ClientId, tenant, req.Secret, refresh ?? "");
            }
            return token;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ApiException(408, Texts.L("Mail Cleaner stopped waiting for your browser. Please sign in again.",
                "Mail Cleaner dejó de esperar a tu navegador. Vuelve a iniciar sesión."));
        }
        finally
        {
            lock (_gate)
            {
                if (_waiting == wait) _waiting = null;
            }
        }
    }

    /// <summary>A new access token from the refresh token, or "interaction_required" when the user has to sign in again.</summary>
    public async Task<JsonObject> RenewAsync(string provider, CancellationToken ct)
    {
        bool google = IsGoogle(provider);
        Session? session;
        lock (_gate) _sessions.TryGetValue(provider, out session);
        if (session is not { Refresh.Length: > 0 }) return new JsonObject { ["error"] = "interaction_required" };

        Dictionary<string, string> fields = new()
        {
            ["client_id"] = session.ClientId,
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = session.Refresh,
        };
        if (!google) fields["scope"] = MicrosoftScopes;
        else if (!string.IsNullOrEmpty(session.Secret)) fields["client_secret"] = session.Secret;

        JsonObject token = await PostAsync(TokenUrl(google, session.Tenant), fields, ct);
        string? refresh = TakeRefresh(token);
        lock (_gate)
        {
            // Microsoft hands out a new refresh token each time; a refused one is no use any more.
            if (token["access_token"] is not null && refresh is not null) _sessions[provider] = session with { Refresh = refresh };
            else if (Text(token, "error") == "invalid_grant") _sessions.Remove(provider);
        }
        return token;
    }

    /// <summary>Forgets the refresh token. For Google it also withdraws the app's access, as the website does.</summary>
    public async Task SignOutAsync(string provider, CancellationToken ct)
    {
        bool google = IsGoogle(provider);
        Session? session;
        lock (_gate) _sessions.Remove(provider, out session);
        if (!google || session is not { Refresh.Length: > 0 }) return;
        try
        {
            using FormUrlEncodedContent form = new(new Dictionary<string, string> { ["token"] = session.Refresh });
            using HttpResponseMessage res = await _http.PostAsync("https://oauth2.googleapis.com/revoke", form, ct);
        }
        catch (HttpRequestException) { }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
    }

    private async Task<JsonObject> PostAsync(string url, Dictionary<string, string> fields, CancellationToken ct)
    {
        try
        {
            using FormUrlEncodedContent form = new(fields);
            using HttpResponseMessage res = await _http.PostAsync(url, form, ct);
            string text = await res.Content.ReadAsStringAsync(ct);
            try
            {
                if (JsonNode.Parse(text) is JsonObject answer) return answer;
            }
            catch (JsonException) { }
            return new JsonObject
            {
                ["error"] = "server_error",
                ["error_description"] = Texts.L($"The sign-in service answered {(int)res.StatusCode}.",
                    $"El servicio de inicio de sesión respondió {(int)res.StatusCode}."),
            };
        }
        catch (HttpRequestException)
        {
            throw new ApiException(503, Texts.L("Couldn't reach the sign-in service. Check your internet connection.",
                "No se pudo conectar con el servicio de inicio de sesión. Comprueba tu conexión a internet."));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ApiException(504, Texts.L("The sign-in service didn't answer. Please try again.",
                "El servicio de inicio de sesión no respondió. Inténtalo de nuevo."));
        }
    }

    /// <summary>Takes the refresh token out of a token answer: it never goes to the page.</summary>
    private static string? TakeRefresh(JsonObject token)
    {
        string? refresh = Text(token, "refresh_token");
        token.Remove("refresh_token");
        return refresh;
    }

    private static string? Text(JsonObject answer, string name) => answer[name] is JsonValue value && value.TryGetValue(out string? text) ? text : null;

    private static bool IsGoogle(string provider) => provider switch
    {
        "google" => true,
        "microsoft" => false,
        _ => throw new ApiException(400, Texts.L("Unknown sign-in service.", "Servicio de inicio de sesión desconocido.")),
    };

    private static string TenantOf(string? tenant) =>
        tenant is { Length: > 0 and <= 100 } && tenant.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-') ? tenant : "common";

    private static string MicrosoftUrl(string tenant, string path) => $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{path}";

    private static string TokenUrl(bool google, string tenant) => google ? "https://oauth2.googleapis.com/token" : MicrosoftUrl(tenant, "token");

    private static string Form(Dictionary<string, string> fields) =>
        string.Join('&', fields.Select(f => $"{Uri.EscapeDataString(f.Key)}={Uri.EscapeDataString(f.Value)}"));

    /// <summary>PKCE (RFC 7636): the S256 challenge for a verifier.</summary>
    internal static string Challenge(string verifier) => Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    internal static string RandomText(int bytes) => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(bytes));

    public void Dispose() => _http.Dispose();

    /// <summary>The browser's way back from the sign-in page: a one-off listener on a free loopback port.</summary>
    internal sealed class LoopbackRedirect : IDisposable
    {
        private readonly string _path;
        private readonly TcpListener _v4;
        private readonly TcpListener? _v6;

        public int Port { get; }

        public LoopbackRedirect(string path)
        {
            _path = path;
            _v4 = new TcpListener(IPAddress.Loopback, 0);
            _v4.Start();
            Port = ((IPEndPoint)_v4.LocalEndpoint).Port;
            // Browsers may try "localhost" on ::1 first: answer there too when this computer has IPv6.
            _v6 = TryListen(IPAddress.IPv6Loopback, Port);
        }

        private static TcpListener? TryListen(IPAddress address, int port)
        {
            TcpListener? listener = null;
            try
            {
                listener = new TcpListener(address, port);
                listener.Start();
                return listener;
            }
            catch (SocketException)
            {
                listener?.Stop();
                return null;
            }
        }

        /// <summary>The query of the request that carries this sign-in's state. Anything else gets a 404 and is ignored.</summary>
        public async Task<Dictionary<string, string>> WaitAsync(string state, CancellationToken ct)
        {
            TaskCompletionSource<Dictionary<string, string>> answer = new(TaskCreationOptions.RunContinuationsAsynchronously);
            async Task RespondAsync(string target, Stream stream)
            {
                Dictionary<string, string>? query = ParseRedirect(target, _path);
                if (query is null || query.GetValueOrDefault("state") != state)
                {
                    await LoopbackHttp.NotFoundAsync(stream);
                    return;
                }
                answer.TrySetResult(query);
                string page = query.ContainsKey("error")
                    ? LoopbackHttp.MessagePage(Texts.L("The sign-in didn't finish", "El inicio de sesión no terminó"),
                        Texts.L("Go back to Mail Cleaner to see why.", "Vuelve a Mail Cleaner para ver por qué."))
                    : LoopbackHttp.MessagePage(Texts.L("You're signed in", "Has iniciado sesión"),
                        Texts.L("Go back to Mail Cleaner. You can close this tab.", "Vuelve a Mail Cleaner. Puedes cerrar esta pestaña."));
                await LoopbackHttp.WriteAsync(stream, "200 OK", "text/html; charset=utf-8", Encoding.UTF8.GetBytes(page));
            }
            _ = LoopbackHttp.ServeAsync(_v4, RespondAsync, ct);
            if (_v6 is not null) _ = LoopbackHttp.ServeAsync(_v6, RespondAsync, ct);
            return await answer.Task.WaitAsync(ct);
        }

        /// <summary>The query parameters of a request for this path, or null for any other path.</summary>
        internal static Dictionary<string, string>? ParseRedirect(string target, string path)
        {
            string[] parts = target.Split('?', 2);
            if (parts[0] != path) return null;
            Dictionary<string, string> query = [];
            foreach (string pair in parts.Length == 2 ? parts[1].Split('&', StringSplitOptions.RemoveEmptyEntries) : [])
            {
                string[] item = pair.Split('=', 2);
                query.TryAdd(Decode(item[0]), item.Length == 2 ? Decode(item[1]) : "");
            }
            return query;
        }

        private static string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

        public void Dispose()
        {
            _v4.Stop();
            _v6?.Stop();
        }
    }
}
