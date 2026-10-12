// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Net.Mail;
using System.Security.Cryptography;
using System.Text.Json;

namespace MailCleaner;

/// <summary>
/// The IMAP login, checked once at setup and then kept on disk encrypted with Windows DPAPI (elsewhere only while
/// the app runs). It's the only password the app ever holds, and it only goes to the mail server, over TLS.
/// Signing out blanks the password but keeps the server, so the form comes back filled in.
/// </summary>
public sealed class ImapStore
{
    readonly string path;
    volatile ImapLogin? login;

    public ImapStore(string dataDir)
    {
        path = Path.Combine(dataDir, "imap_login.bin");
        login = Read();
    }

    public string? Error { get; private set; }

    /// <summary>The login to connect with, or null while the user has to type the password.</summary>
    public ImapLogin? Active => login is { Password.Length: > 0 } l ? l : null;

    public ImapState State()
    {
        var l = login;
        return new ImapState(
            l is { Password.Length: > 0 },
            l?.Email,
            l is not null && l.User != l.Email ? l.User : null,
            l?.Host,
            l?.Port ?? 993,
            l?.StartTls == true ? "starttls" : "ssl",
            Error,
            OperatingSystem.IsWindows());
    }

    /// <summary>Validates the form and signs in once, so a wrong server or password shows up right away.</summary>
    public async Task SetupAsync(ImapSetup req, CancellationToken ct)
    {
        var email = req.Email?.Trim() ?? "";
        if (!MailAddress.TryCreate(email, out var address) || address.Address != email)
            throw new ApiException(400, "Type your email address, for example name@example.com.");
        var host = req.Host?.Trim().ToLowerInvariant() ?? "";
        if (!ImapServers.HostName().IsMatch(host)) throw new ApiException(400, "Type the IMAP server, for example imap.example.com.");
        var port = req.Port ?? 993;
        if (port is < 1 or > 65535) throw new ApiException(400, "The port is a number, usually 993.");
        var user = string.IsNullOrWhiteSpace(req.User) ? email : req.User.Trim();
        var draft = new ImapLogin(email, user, host, port, req.Security == "starttls", "");
        var password = !string.IsNullOrEmpty(req.Password) ? req.Password
            : Active is { } saved && saved with { Password = "" } == draft ? saved.Password   // same server and user: keep the saved one
            : throw new ApiException(400, "Type your password, or an app password.");
        var checkedLogin = draft with { Password = password };
        if (await ImapConnection.TestAsync(checkedLogin, ct) is { } problem) throw new ApiException(400, problem);
        Save(checkedLogin);
    }

    public void SignOut() => Save(login is { } l ? l with { Password = "" } : null);

    /// <summary>The server stopped accepting the saved password (changed or revoked), so forget it.</summary>
    public void Refused()
    {
        SignOut();
        Error = "Your mail server refused the saved password. Type it again.";
    }

    void Save(ImapLogin? value)
    {
        login = value;
        Error = null;
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            if (value is null)
            {
                File.Delete(path);
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(value, ShellJson.Default.ImapLogin), null, DataProtectionScope.CurrentUser));
        }
        // Not saved: the login still works until the app closes.
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException) { }
    }

    ImapLogin? Read()
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            return JsonSerializer.Deserialize(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser), ShellJson.Default.ImapLogin);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or CryptographicException or JsonException)
        {
            return null;
        }
    }
}
