// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Net;
using System.Net.Sockets;
using System.Text;

namespace MailCleaner;

/// <summary>Just enough HTTP for the two loopback servers: the app's own files, and the browser coming back from a sign-in.</summary>
internal static class LoopbackHttp
{
    /// <summary>
    /// Answers GET requests for this computer until the listener stops. Each connection gets its own task: browsers
    /// open spare connections that never send anything.
    /// </summary>
    internal static async Task ServeAsync(TcpListener listener, Func<string, Stream, Task> respond, CancellationToken ct = default)
    {
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        while (true)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(ct);
            }
            catch (Exception e) when (e is OperationCanceledException or SocketException or ObjectDisposedException)
            {
                return;
            }
            _ = Task.Run(async () =>
            {
                using (client)
                {
                    try
                    {
                        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(30));
                        NetworkStream stream = client.GetStream();
                        if (await ReadRequestTarget(stream, port, timeout.Token) is { } target) await respond(target, stream);
                    }
                    catch (Exception e) when (e is IOException or SocketException or OperationCanceledException) { }
                }
            });
        }
    }

    /// <summary>
    /// The target of a GET request addressed to this port on this computer, or null. Checking the Host header defeats
    /// DNS rebinding: a website can't make the browser treat this server as its own.
    /// </summary>
    internal static async Task<string?> ReadRequestTarget(Stream stream, int port, CancellationToken ct = default)
    {
        byte[] buffer = new byte[8192];
        int received = 0;
        while (received < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(received), ct);
            if (read == 0) return null;
            received += read;
            int end = buffer.AsSpan(0, received).IndexOf("\r\n\r\n"u8);
            if (end < 0) continue;

            string[] lines = Encoding.ASCII.GetString(buffer, 0, end).Split("\r\n");
            string[] parts = lines[0].Split(' ');
            if (parts.Length != 3 || parts[0] != "GET" || !parts[1].StartsWith('/')) return null;
            string? host = lines.Skip(1)
                .Select(line => line.Split(':', 2))
                .Where(header => header.Length == 2 && header[0].Equals("Host", StringComparison.OrdinalIgnoreCase))
                .Select(header => header[1].Trim())
                .FirstOrDefault();
            bool local = host is not null && (host.Equals($"127.0.0.1:{port}", StringComparison.OrdinalIgnoreCase)
                || host.Equals($"localhost:{port}", StringComparison.OrdinalIgnoreCase));
            return local ? parts[1] : null;
        }
        return null;
    }

    internal static async Task WriteAsync(Stream stream, string status, string type, byte[] body, CancellationToken ct = default)
    {
        // The page carries its own Content Security Policy; the header adds what a meta tag can't: no framing by other sites.
        string head = $"HTTP/1.1 {status}\r\n"
            + $"Content-Type: {type}\r\n"
            + $"Content-Length: {body.Length}\r\n"
            + "Cache-Control: no-store\r\n"
            + "Content-Security-Policy: frame-ancestors 'none'\r\n"
            + "X-Content-Type-Options: nosniff\r\n"
            + "Referrer-Policy: no-referrer\r\n"
            + "Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head), ct);
        await stream.WriteAsync(body, ct);
        await stream.FlushAsync(ct);
    }

    internal static Task NotFoundAsync(Stream stream) => WriteAsync(stream, "404 Not Found", "text/plain; charset=utf-8", "Not found"u8.ToArray());

    /// <summary>A plain page for the app's messages outside its window. The texts are the app's own, never user input.</summary>
    internal static string MessagePage(string heading, params string[] paragraphs) => $"""
        <!doctype html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Mail Cleaner</title>
        <body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.5rem">
        <h1 style="font-size:1.4rem">{heading}</h1>
        {string.Concat(paragraphs.Select(p => $"<p>{p}</p>"))}
        </body>
        </html>
        """;
}
