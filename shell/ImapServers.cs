// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace MailCleaner;

/// <summary>Finds the IMAP server for an email address: well-known services first, then Thunderbird's public ISP database.</summary>
public static partial class ImapServers
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    const string AppPassword = "needs an app password: create one in your account's security settings and use it here.";
    const string AppPasswordEs = "necesita una contraseña de aplicación: créala en la configuración de seguridad de tu cuenta y úsala aquí.";
    const string Gmx = "Turn on IMAP in your GMX settings first (POP3 & IMAP).";
    const string GmxEs = "Activa antes IMAP en la configuración de GMX (POP3 & IMAP).";
    const string Zoho = "Turn on IMAP access in Zoho Mail settings. With two-step sign-in, use an app password.";
    const string ZohoEs = "Activa el acceso IMAP en la configuración de Zoho Mail. Con la verificación en dos pasos, usa una contraseña de aplicación.";

    /// <summary>Well-known services, with a tip in English and in Spanish.</summary>
    static readonly (string[] Domains, string Host, int Port, bool StartTls, (string En, string Es)? Tip)[] Known =
    [
        (["yahoo.*", "ymail.com", "rocketmail.com"], "imap.mail.yahoo.com", 993, false, ("Yahoo " + AppPassword, "Yahoo " + AppPasswordEs)),
        (["aol.com", "aim.com"], "imap.aol.com", 993, false, ("AOL " + AppPassword, "AOL " + AppPasswordEs)),
        (["icloud.com", "me.com", "mac.com"], "imap.mail.me.com", 993, false,
            ("iCloud needs an app-specific password: account.apple.com, Sign-In and Security, App-Specific Passwords.",
                "iCloud necesita una contraseña específica de app: account.apple.com, Inicio de sesión y seguridad, Contraseñas específicas de apps.")),
        (["gmx.net", "gmx.de", "gmx.at", "gmx.ch"], "imap.gmx.net", 993, false, (Gmx, GmxEs)),
        (["gmx.*"], "imap.gmx.com", 993, false, (Gmx, GmxEs)),
        (["web.de"], "imap.web.de", 993, false,
            ("Turn on IMAP in your WEB.DE settings first (POP3 & IMAP).", "Activa antes IMAP en la configuración de WEB.DE (POP3 & IMAP).")),
        (["zoho.eu"], "imap.zoho.eu", 993, false, (Zoho, ZohoEs)),
        (["zoho.com", "zohomail.com"], "imap.zoho.com", 993, false, (Zoho, ZohoEs)),
        (["fastmail.com", "fastmail.fm"], "imap.fastmail.com", 993, false, ("Fastmail " + AppPassword, "Fastmail " + AppPasswordEs)),
        (["yandex.*", "ya.ru"], "imap.yandex.com", 993, false,
            ("Turn on IMAP in Yandex Mail settings; Yandex " + AppPassword, "Activa IMAP en la configuración de Yandex Mail; Yandex " + AppPasswordEs)),
        (["mail.ru", "inbox.ru", "list.ru", "bk.ru"], "imap.mail.ru", 993, false, ("Mail.ru " + AppPassword, "Mail.ru " + AppPasswordEs)),
        (["t-online.de"], "secureimap.t-online.de", 993, false,
            ("Use your email password from the Telekom email center, not your Telekom login.",
                "Usa la contraseña de correo del centro de correo de Telekom, no la de tu inicio de sesión de Telekom.")),
        (["proton.me", "protonmail.com", "protonmail.ch", "pm.me"], "127.0.0.1", 1143, true,
            ("Proton Mail works through Proton Mail Bridge: install it, sign in there, then use the user name and password the Bridge shows.",
                "Proton Mail funciona mediante Proton Mail Bridge: instálalo, inicia sesión allí y luego usa el nombre de usuario y la contraseña que muestra el Bridge.")),
    ];

    public static async Task<ImapSuggestion> FindAsync(string email, CancellationToken ct)
    {
        var at = email.LastIndexOf('@');
        var domain = at > 0 ? email[(at + 1)..].Trim().ToLowerInvariant() : "";
        if (!HostName().IsMatch(domain) || !domain.Contains('.'))
            throw new ApiException(400, Texts.L("Type your whole email address first.", "Escribe antes tu dirección de correo completa."));

        if (domain is "gmail.com" or "googlemail.com") return new(null, 993, "ssl", null, null, "gmail");
        if (MicrosoftDomain().IsMatch(domain)) return new(null, 993, "ssl", null, null, "outlook");
        foreach (var (domains, host, port, startTls, tip) in Known)
            if (domains.Any(d => d.EndsWith(".*") ? domain.StartsWith(d[..^1], StringComparison.Ordinal) && domain.Count(c => c == '.') <= 2 : domain == d))
                return new(host, port, startTls ? "starttls" : "ssl", null, tip is { } words ? Texts.L(words.En, words.Es) : null, null);
        return await FromThunderbirdAsync(email.Trim(), domain, ct) ?? new($"imap.{domain}", 993, "ssl", null, null, null);
    }

    /// <summary>Mozilla's database of mail providers (autoconfig.thunderbird.net). Only the domain is sent.</summary>
    static async Task<ImapSuggestion?> FromThunderbirdAsync(string email, string domain, CancellationToken ct)
    {
        try
        {
            using var response = await Http.GetAsync($"https://autoconfig.thunderbird.net/v1.1/{Uri.EscapeDataString(domain)}", ct);
            if (!response.IsSuccessStatusCode) return null;
            var server = XDocument.Parse(await response.Content.ReadAsStringAsync(ct))
                .Descendants("incomingServer")
                .FirstOrDefault(s => (string?)s.Attribute("type") == "imap" && (string?)s.Element("socketType") is "SSL" or "STARTTLS");
            var host = ((string?)server?.Element("hostname"))?.Trim().ToLowerInvariant();
            if (server is null || host is null || !HostName().IsMatch(host)) return null;
            var user = ((string?)server.Element("username") ?? "%EMAILADDRESS%")
                .Replace("%EMAILADDRESS%", email).Replace("%EMAILLOCALPART%", email[..email.IndexOf('@')]).Replace("%EMAILDOMAIN%", domain);
            return new(host, int.TryParse((string?)server.Element("port"), out var port) ? port : 993,
                (string?)server.Element("socketType") == "STARTTLS" ? "starttls" : "ssl", user == email ? null : user, null, null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or XmlException)
        {
            return null;
        }
    }

    [GeneratedRegex(@"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")]
    public static partial Regex HostName();

    [GeneratedRegex(@"^(outlook|hotmail|live|msn|windowslive|passport)\.[a-z]{2,3}(\.[a-z]{2})?$")]
    private static partial Regex MicrosoftDomain();
}
