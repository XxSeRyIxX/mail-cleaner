using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using MailCleaner;

async Task<string?> ReadTarget(string request, int chunkSize = 3)
{
    using ChunkedStream stream = new(Encoding.ASCII.GetBytes(request), chunkSize);
    return await LoopbackHttp.ReadRequestTarget(stream, 5180);
}

void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

// Requests: in any fragments, GET only, complete headers, a size limit, and only for this computer's own names.
foreach (int size in new[] { 1, 3, 512 })
{
    Check(await ReadTarget("GET /index.html?test=1 HTTP/1.1\r\nHost: 127.0.0.1:5180\r\n\r\n", size) == "/index.html?test=1",
        $"Request parsing failed for {size}-byte chunks.");
}
Check(await ReadTarget("GET / HTTP/1.1\r\nhost: LOCALHOST:5180\r\n\r\n") == "/", "Host names are case-insensitive.");
Check(await ReadTarget("POST / HTTP/1.1\r\nHost: 127.0.0.1:5180\r\n\r\n") is null, "Non-GET requests must be rejected.");
Check(await ReadTarget("GET / HTTP/1.1\r\nHost: 127.0.0.1:5180") is null, "Incomplete headers must be rejected.");
Check(await ReadTarget("GET / HTTP/1.1\r\nHost: 127.0.0.1:5180\r\nX: " + new string('x', 8192) + "\r\n\r\n") is null,
    "Oversized headers must be rejected.");
Check(await ReadTarget("GET / HTTP/1.1\r\nHost: rebound.example:5180\r\n\r\n") is null, "Other host names must be rejected.");
Check(await ReadTarget("GET / HTTP/1.1\r\nHost: 127.0.0.1:5181\r\n\r\n") is null, "Other ports must be rejected.");
Check(await ReadTarget("GET / HTTP/1.1\r\n\r\n") is null, "Requests without a host must be rejected.");
Check(await ReadTarget("GET http://127.0.0.1:5180/ HTTP/1.1\r\nHost: 127.0.0.1:5180\r\n\r\n") is null, "Proxy requests must be rejected.");

// The app's own files: exact names only, so nothing outside app/ can be reached.
Check(Site.Open("/") is { Type: "text/html; charset=utf-8" }, "The root must serve index.html.");
Check(Site.Open("/app.js?v=abc1234") is { Type: "text/javascript; charset=utf-8" }, "Stamped module URLs must be served.");
foreach (string target in new[] { "/../shell/Program.cs", "/%2e%2e/LICENSE", "/..%2fNOTICE", "/APP.JS", "/app.js%00", "//app.js/.." })
    Check(Site.Open(target) is null, $"{target} must not be served.");

// Links that leave the app: web and mail only, anything else could start a program.
foreach (string url in new[] { "https://example.com/unsubscribe?u=1", "http://example.com/", "mailto:leave@example.com?subject=stop" })
    Check(Desktop.SafeLink(url) is not null, $"{url} must open.");
foreach (string url in new[] { "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "data:text/html,x",
             "/relative", "", "https://example.com/\nx" })
    Check(Desktop.SafeLink(url) is null, $"{url} must not open.");

// Export names: plain text formats, never a path or a program.
foreach (string name in new[] { "outlook-senders-2026-05-01.csv", "mail-cleaner-ai-2026-05-01.md" })
    Check(Desktop.SafeFileName(name) == name, $"{name} must be allowed.");
foreach (string name in new[] { "../evil.csv", "..\\evil.csv", "C:\\evil.csv", "evil.exe", "evil.csv.lnk", ".csv", "evil.desktop", "" })
    Check(Desktop.SafeFileName(name) is null, $"{name} must be refused.");

// PKCE: the S256 example of RFC 7636, appendix B.
Check(SignIn.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "PKCE challenge is wrong.");
Check(SignIn.RandomText(32).Length == 43, "PKCE verifiers must have 43 characters.");

// The browser's way back: only the expected path, decoded.
Dictionary<string, string>? query = SignIn.LoopbackRedirect.ParseRedirect("/mail-cleaner?code=a%2Fb&state=s1&error_description=x+y", "/mail-cleaner");
Check(query is not null && query["code"] == "a/b" && query["state"] == "s1" && query["error_description"] == "x y", "Redirect parsing failed.");
Check(SignIn.LoopbackRedirect.ParseRedirect("/other?code=a", "/mail-cleaner") is null, "Other paths must be ignored.");

// A real round trip: a wrong state gets a 404 and changes nothing, the right one finishes the sign-in.
using (SignIn.LoopbackRedirect redirect = new("/mail-cleaner"))
using (CancellationTokenSource timeout = new(TimeSpan.FromSeconds(20)))
{
    Task<Dictionary<string, string>> waiting = redirect.WaitAsync("s1", timeout.Token);
    Check((await Get(redirect.Port, "/mail-cleaner?code=x&state=wrong")).StartsWith("HTTP/1.1 404"), "A wrong state must be refused.");
    Check(!waiting.IsCompleted, "A wrong state must not finish the sign-in.");
    Check((await Get(redirect.Port, "/mail-cleaner?code=right&state=s1")).StartsWith("HTTP/1.1 200"), "The right state must be answered.");
    Check((await waiting)["code"] == "right", "The sign-in must finish with the right code.");
}

// Messages: camelCase both ways, strict about required values.
Request request = JsonSerializer.Deserialize("""{"id":"a-1","cmd":"imap.uids","args":{"folder":"INBOX"}}""", ShellJson.Default.Request)!;
Check(request.Args.Deserialize(ShellJson.Default.FolderRequest)!.Folder == "INBOX", "Request arguments must be read.");
string reply = JsonSerializer.Serialize(
    new Reply("a-1", true, JsonSerializer.SerializeToNode(new EmptiedTrash(3), ShellJson.Default.EmptiedTrash)), ShellJson.Default.Reply);
Check(reply.Contains("\"data\":{\"count\":3}"), $"Reply serialized wrongly: {reply}");
foreach (string bad in new[] { """{"url":null}""", "{}" })
{
    bool refused = false;
    try
    {
        JsonSerializer.Deserialize(bad, ShellJson.Default.OpenRequest);
    }
    catch (JsonException)
    {
        refused = true;
    }
    Check(refused, $"{bad} must be refused: the URL is required.");
}
Check(JsonSerializer.Deserialize("""{"email":"a@b.example","host":"imap.b.example"}""", ShellJson.Default.ImapSetup)?.User is null,
    "Optional values may be left out.");
ImapLogin? saved = JsonSerializer.Deserialize(
    """{"Email":"a@b.example","User":"a@b.example","Host":"imap.b.example","Port":993,"StartTls":false,"Password":"p"}""",
    ShellJson.Default.ImapLogin);
Check(saved?.Host == "imap.b.example", "Logins saved by earlier versions must still load.");

Console.WriteLine("Desktop checks passed: requests and hosts, app files, outside links, export names, PKCE, the sign-in redirect and messages.");

static async Task<string> Get(int port, string target)
{
    using TcpClient client = new();
    await client.ConnectAsync("127.0.0.1", port);
    NetworkStream stream = client.GetStream();
    await stream.WriteAsync(Encoding.ASCII.GetBytes($"GET {target} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"));
    using StreamReader reader = new(stream);
    return await reader.ReadToEndAsync();
}

sealed class ChunkedStream(byte[] bytes, int chunkSize) : MemoryStream(bytes)
{
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
        base.ReadAsync(buffer[..Math.Min(buffer.Length, chunkSize)], cancellationToken);
}
