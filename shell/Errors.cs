// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Text.Json;

namespace MailCleaner;

/// <summary>An answer for the page: an HTTP-like status and a message in plain words.</summary>
public sealed class ApiException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>The mail server refused the saved password: the user has to type it again.</summary>
public sealed class NotSignedInException(string message) : Exception(message);

/// <summary>The mail server answered with an error, or the connection broke.</summary>
public sealed class MailServerException(string message) : Exception(message);

internal static class Errors
{
    /// <summary>The status and message the page gets for a failed request. 401 sends it back to the sign-in.</summary>
    public static (int Status, string Message) Explain(Exception e) => e switch
    {
        OperationCanceledException => (499, Texts.L("Stopped.", "Detenido.")),
        NotSignedInException => (401, e.Message),
        ApiException a => (a.Status, a.Message),
        MailServerException => (502, Texts.L("Mail server: ", "Servidor de correo: ") + e.Message),
        JsonException => (400, Texts.L("Bad request.", "Petición incorrecta.")),
        _ => (500, e.Message),
    };
}
