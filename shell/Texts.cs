// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Globalization;

namespace MailCleaner;

/// <summary>
/// The shell's own words in the page's language, English or Spanish, as the page's are in app/i18n.js. The page says
/// which with the "lang" command; until it has, the system's language decides.
/// </summary>
internal static class Texts
{
    private static volatile bool spanish = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "es";

    /// <summary>"es" or "en", for the lang attribute of the shell's own pages.</summary>
    public static string Lang => spanish ? "es" : "en";

    public static void Use(string? lang) => spanish = lang == "es";

    /// <summary>The English or the Spanish of a text, whichever the page uses.</summary>
    public static string L(string english, string inSpanish) => spanish ? inSpanish : english;
}
