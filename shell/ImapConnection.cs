// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Net;
using System.Net.Sockets;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Security;

namespace MailCleaner;

/// <summary>
/// The app's one IMAP connection. IMAP runs one command at a time, so requests take turns a batch at a time.
/// The connection opens on first use and reopens when the server drops it.
/// </summary>
public sealed class ImapConnection(ImapStore store)
{
    const int Attempts = 4;
    readonly SemaphoreSlim gate = new(1, 1);
    ImapClient? client;
    ImapLogin? connectedAs;

    public async Task<T> RunAsync<T>(Func<ImapClient, Task<T>> work, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    return await work(await ClientAsync(ct));
                }
                catch (Exception e) when (Dropped(e) && attempt < Attempts && !ct.IsCancellationRequested)
                {
                    Drop();
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)), ct);
                }
            }
        }
        catch (OperationCanceledException)
        {
            if (client is { IsConnected: false }) Drop();   // a command cut off halfway leaves MailKit disconnected
            throw;
        }
        catch (AuthenticationException)
        {
            Drop();
            store.Refused();
            throw new NotSignedInException(store.Error ?? "Please sign in again.");
        }
        catch (ImapCommandException e)
        {
            throw new MailServerException(e.ResponseText is { Length: > 0 } text ? text : e.Message);
        }
        catch (Exception e) when (Dropped(e) || e is SslHandshakeException)
        {
            Drop();
            throw new MailServerException("Lost the connection to the mail server: " + e.Message);
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Closes the connection, so the next operation signs in with the current login.</summary>
    public async Task ResetAsync()
    {
        await gate.WaitAsync();
        try
        {
            Drop();
        }
        finally
        {
            gate.Release();
        }
    }

    async Task<ImapClient> ClientAsync(CancellationToken ct)
    {
        var login = store.Active ?? throw new NotSignedInException("Please sign in to your mail server again.");
        if (client is { IsConnected: true, IsAuthenticated: true } && connectedAs == login) return client;
        Drop();
        client = await ConnectAsync(login, ct);
        connectedAs = login;
        return client;
    }

    void Drop()
    {
        var c = client;
        client = null;
        connectedAs = null;
        if (c is null) return;
        try
        {
            if (c.IsConnected) c.Disconnect(false);
        }
        catch (Exception e) when (e is IOException or SocketException or ImapProtocolException) { }
        c.Dispose();
    }

    static bool Dropped(Exception e) => e is IOException or SocketException or ImapProtocolException or ServiceNotConnectedException;

    public static async Task<ImapClient> ConnectAsync(ImapLogin login, CancellationToken ct)
    {
        var c = new ImapClient { Timeout = 60_000 };
        // Local bridges such as Proton Mail Bridge use a self-signed certificate; that traffic never leaves this PC.
        if (IsLoopback(login.Host)) c.ServerCertificateValidationCallback = (_, _, _, _) => true;
        try
        {
            await c.ConnectAsync(login.Host, login.Port, login.StartTls ? SecureSocketOptions.StartTls : SecureSocketOptions.SslOnConnect, ct);
            await c.AuthenticateAsync(login.User, login.Password, ct);
            return c;
        }
        catch
        {
            c.Dispose();
            throw;
        }
    }

    /// <summary>Signs in once with these details. Returns what went wrong, in plain words, or null when it worked.</summary>
    public static async Task<string?> TestAsync(ImapLogin login, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var where = $"{login.Host}:{login.Port}";
        try
        {
            using var c = await ConnectAsync(login, timeout.Token);
            await c.DisconnectAsync(true, timeout.Token);
            return null;
        }
        catch (AuthenticationException)
        {
            return $"{login.Host} refused that user name and password. Many providers only let other apps in with an app password: " +
                   "create one in your account's security settings and use it here.";
        }
        catch (SslHandshakeException)
        {
            return $"Couldn't open a secure connection to {where}. Check the port and security (usually 993 with SSL/TLS, or 143 with STARTTLS).";
        }
        catch (NotSupportedException e) when (e.Message.Contains("STARTTLS", StringComparison.OrdinalIgnoreCase))
        {
            return $"{where} doesn't offer STARTTLS, so the app won't send your password there. Try port 993 with SSL/TLS.";
        }
        catch (NotSupportedException)
        {
            return $"{login.Host} doesn't let apps sign in with a password over IMAP.";
        }
        catch (Exception e) when (e is SocketException or IOException or ImapProtocolException or OperationCanceledException)
        {
            return ct.IsCancellationRequested ? "Cancelled." : $"Couldn't reach an IMAP server at {where}. Check the server name and port.";
        }
    }

    static bool IsLoopback(string host) => host == "localhost" || IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip);
}
