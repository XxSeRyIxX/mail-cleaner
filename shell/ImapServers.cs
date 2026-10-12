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

    static readonly (string[] Domains, string Host, int Port, bool StartTls, string? Tip)[] Known =
    [
        (["yahoo.*", "ymail.com", "rocketmail.com"], "imap.mail.yahoo.com", 993, false, "Yahoo " + AppPassword),
        (["aol.com", "aim.com"], "imap.aol.com", 993, false, "AOL " + AppPassword),
        (["icloud.com", "me.com", "mac.com"], "imap.mail.me.com", 993, false,
            "iCloud needs an app-specific password: account.apple.com, Sign-In and Security, App-Specific Passwords."),
        (["gmx.net", "gmx.de", "gmx.at", "gmx.ch"], "imap.gmx.net", 993, false, "Turn on IMAP in your GMX settings first (POP3 & IMAP)."),
        (["gmx.*"], "imap.gmx.com", 993, false, "Turn on IMAP in your GMX settings first (POP3 & IMAP)."),
        (["web.de"], "imap.web.de", 993, false, "Turn on IMAP in your WEB.DE settings first (POP3 & IMAP)."),
        (["zoho.eu"], "imap.zoho.eu", 993, false, "Turn on IMAP access in Zoho Mail settings. With two-step sign-in, use an app password."),
        (["zoho.com", "zohomail.com"], "imap.zoho.com", 993, false, "Turn on IMAP access in Zoho Mail settings. With two-step sign-in, use an app password."),
        (["fastmail.com", "fastmail.fm"], "imap.fastmail.com", 993, false, "Fastmail " + AppPassword),
        (["yandex.*", "ya.ru"], "imap.yandex.com", 993, false, "Turn on IMAP in Yandex Mail settings; Yandex " + AppPassword),
        (["mail.ru", "inbox.ru", "list.ru", "bk.ru"], "imap.mail.ru", 993, false, "Mail.ru " + AppPassword),
        (["t-online.de"], "secureimap.t-online.de", 993, false, "Use your email password from the Telekom email center, not your Telekom login."),
        (["proton.me", "protonmail.com", "protonmail.ch", "pm.me"], "127.0.0.1", 1143, true,
            "Proton Mail works through Proton Mail Bridge: install it, sign in there, then use the user name and password the Bridge shows."),
    ];

    public static async Task<ImapSuggestion> FindAsync(string email, CancellationToken ct)
    {
        var at = email.LastIndexOf('@');
        var domain = at > 0 ? email[(at + 1)..].Trim().ToLowerInvariant() : "";
        if (!HostName().IsMatch(domain) || !domain.Contains('.')) throw new ApiException(400, "Type your whole email address first.");

        if (domain is "gmail.com" or "googlemail.com") return new(null, 993, "ssl", null, null, "gmail");
        if (MicrosoftDomain().IsMatch(domain)) return new(null, 993, "ssl", null, null, "outlook");
        foreach (var (domains, host, port, startTls, tip) in Known)
            if (domains.Any(d => d.EndsWith(".*") ? domain.StartsWith(d[..^1], StringComparison.Ordinal) && domain.Count(c => c == '.') <= 2 : domain == d))
                return new(host, port, startTls ? "starttls" : "ssl", null, tip, null);
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
