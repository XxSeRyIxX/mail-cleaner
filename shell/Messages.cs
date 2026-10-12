// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace MailCleaner;

// What the page (app/native.js) and the shell send each other. The published app is trimmed, so JSON can't fall
// back to reflection: every type is listed in ShellJson below.

/// <summary>A request from the page. Args depend on the command.</summary>
public sealed record Request(string Id, string Cmd, JsonElement Args);

/// <summary>The answer to one request: Data when Ok, else an HTTP-like status and a message for the user.</summary>
public sealed record Reply(string Id, bool Ok, JsonNode? Data = null, int? Status = null, string? Error = null);

public sealed record CancelRequest(string Id);
public sealed record OpenRequest(string Url);
public sealed record SaveRequest(string Name, string Text);
public sealed record Saved(string Path);
public sealed record SignInRequest(string Provider, string ClientId, string? Tenant = null, string? Secret = null);
public sealed record ProviderRequest(string Provider);

/// <summary>What the app needs to sign in to an IMAP server. The password is the user's own, or an app password.</summary>
public sealed record ImapLogin(string Email, string User, string Host, int Port, bool StartTls, string Password);
public sealed record ImapSetup(string? Email = null, string? User = null, string? Host = null, int? Port = null, string? Security = null,
    string? Password = null);

/// <summary>The saved IMAP setup for the form. Remembered: the password survives closing the app (Windows only).</summary>
public sealed record ImapState(bool SignedIn, string? Email, string? User, string? Host, int Port, string Security, string? Error, bool Remembered);

/// <summary>IMAP server settings for an address. Security is "ssl" or "starttls"; User is set when it isn't the address.</summary>
public sealed record ImapSuggestion(string? Host, int Port, string Security, string? User, string? Tip, string? UseInstead);
public sealed record LookupRequest(string Email);

public sealed record ImapFolder(string Id, string Name, string Path, int Total, int Unread, long Size, string? WellKnown);
public sealed record FolderList(List<ImapFolder> Folders, string? Archive);
public sealed record FolderRequest(string Folder);
public sealed record UidList(uint Validity, List<uint> Uids);
public sealed record FetchMailsRequest(string Folder, uint Validity, uint[] Uids);
public sealed record ScannedMail(string Id, string Email, string Name, string Subject, long T, long Size, bool Read, bool Attach, string List, string Post);
public sealed record FetchedMails(bool Changed, List<ScannedMail> Mails);
public sealed record ApplyRequest(string Action, string[] Ids);
public sealed record AppliedMail(string Id, string? NewId);
public sealed record Applied(List<AppliedMail> Done);
public sealed record BodyRequest(string Id);
public sealed record MailBody(string Subject, string From, string To, string Content, bool IsHtml);
public sealed record StoragePart(string Name, long? Size, int Count);
public sealed record StorageReport(long? Total, long? Used, List<StoragePart> Parts, StoragePart Trash, string? Note);
public sealed record EmptiedTrash(int Count);

// Missing or null values for non-nullable properties are refused, so a bad request fails here, not halfway through.
// Optional values need a default, or they count as required too.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true,
    RespectNullableAnnotations = true, RespectRequiredConstructorParameters = true)]
[JsonSerializable(typeof(Request))]
[JsonSerializable(typeof(Reply))]
[JsonSerializable(typeof(CancelRequest))]
[JsonSerializable(typeof(OpenRequest))]
[JsonSerializable(typeof(SaveRequest))]
[JsonSerializable(typeof(Saved))]
[JsonSerializable(typeof(SignInRequest))]
[JsonSerializable(typeof(ProviderRequest))]
[JsonSerializable(typeof(ImapLogin))]
[JsonSerializable(typeof(ImapSetup))]
[JsonSerializable(typeof(ImapState))]
[JsonSerializable(typeof(ImapSuggestion))]
[JsonSerializable(typeof(LookupRequest))]
[JsonSerializable(typeof(FolderList))]
[JsonSerializable(typeof(FolderRequest))]
[JsonSerializable(typeof(UidList))]
[JsonSerializable(typeof(FetchMailsRequest))]
[JsonSerializable(typeof(FetchedMails))]
[JsonSerializable(typeof(ApplyRequest))]
[JsonSerializable(typeof(Applied))]
[JsonSerializable(typeof(BodyRequest))]
[JsonSerializable(typeof(MailBody))]
[JsonSerializable(typeof(StorageReport))]
[JsonSerializable(typeof(EmptiedTrash))]
internal sealed partial class ShellJson : JsonSerializerContext;
