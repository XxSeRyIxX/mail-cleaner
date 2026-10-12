// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using MailKit;
using MailKit.Net.Imap;
using MailKit.Search;
using MimeKit;

namespace MailCleaner;

/// <summary>
/// IMAP for the web app, in steps small enough to show progress and to stop between. Folder ids are IMAP folder names;
/// a mail id holds its folder, the folder's UIDVALIDITY and the UID, so actions can tell when a folder was renumbered.
/// </summary>
public sealed class ImapBridge(ImapConnection imap)
{
    const char Separator = '\u001f';
    static readonly string[] HeaderFields = ["Content-Type", "List-Unsubscribe", "List-Unsubscribe-Post"];
    static readonly FetchRequest ScanFields = new(MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.Flags |
                                                  MessageSummaryItems.Size | MessageSummaryItems.InternalDate, HeaderFields);
    // Names for servers without the SPECIAL-USE extension, which flags these folders itself.
    static readonly (string WellKnown, FolderAttributes Attribute, string[] Names)[] Special =
    [
        ("junkemail", FolderAttributes.Junk, ["junk", "spam", "junk e-mail", "junk email", "bulk mail", "correo no deseado"]),
        ("deleteditems", FolderAttributes.Trash, ["trash", "deleted", "deleted items", "deleted messages", "bin", "papelera", "elementos eliminados"]),
        ("archive", FolderAttributes.Archive, ["archive", "archives", "archivo"]),
        ("sentitems", FolderAttributes.Sent, ["sent", "sent items", "sent messages", "sent mail", "enviados", "elementos enviados"]),
        ("drafts", FolderAttributes.Drafts, ["drafts", "borradores"]),
        ("all", FolderAttributes.All, []),
    ];
    static readonly string[] Pinned = ["inbox", "junkemail", "archive"];
    static readonly HashSet<string> NotScanned = ["deleteditems", "sentitems", "drafts", "all"];

    volatile string? trashId, archiveId;

    /// <summary>The folders worth scanning (not Sent, Drafts, Trash or All mail), and which one is Archive.</summary>
    public async Task<FolderList> FoldersAsync(CancellationToken ct)
    {
        var all = await AllFoldersAsync(ct);
        int Rank(ImapFolder f) => f.WellKnown is { } w && Array.IndexOf(Pinned, w) is >= 0 and var i ? i : Pinned.Length;
        return new FolderList(
            all.Where(f => f.WellKnown is null || !NotScanned.Contains(f.WellKnown))
                .OrderBy(Rank).ThenBy(f => f.Path, StringComparer.CurrentCultureIgnoreCase).ToList(),
            archiveId);
    }

    async Task<List<ImapFolder>> AllFoldersAsync(CancellationToken ct)
    {
        var folders = await imap.RunAsync(async c =>
        {
            var items = StatusItems.Count | StatusItems.Unread | (c.Capabilities.HasFlag(ImapCapabilities.StatusSize) ? StatusItems.Size : StatusItems.None);
            var space = c.PersonalNamespaces.Count > 0 ? c.PersonalNamespaces[0] : new FolderNamespace('/', "");
            return (await c.GetFoldersAsync(space, items, false, ct))
                .Where(f => !f.Attributes.HasFlag(FolderAttributes.NoSelect) && !f.Attributes.HasFlag(FolderAttributes.NonExistent))
                .ToList();
        }, ct);

        var known = new Dictionary<IMailFolder, string>();
        foreach (var f in folders)
            if (f.FullName.Equals("INBOX", StringComparison.OrdinalIgnoreCase)) known[f] = "inbox";
        foreach (var (wellKnown, attribute, _) in Special)
            if (folders.FirstOrDefault(f => !known.ContainsKey(f) && f.Attributes.HasFlag(attribute)) is { } flagged) known[flagged] = wellKnown;
        foreach (var (wellKnown, _, names) in Special)
        {
            if (known.ContainsValue(wellKnown)) continue;
            var named = folders.Where(f => !known.ContainsKey(f) && names.Contains(f.Name.ToLowerInvariant()))
                .OrderBy(f => f.FullName.Count(ch => ch == f.DirectorySeparator))
                .FirstOrDefault();
            if (named != null) known[named] = wellKnown;
        }

        var result = folders.Select(f => new ImapFolder(f.FullName, f.Name,
            f.DirectorySeparator == '\0' ? f.FullName : f.FullName.Replace(f.DirectorySeparator.ToString(), " / "),
            f.Count, f.Unread, (long)(f.Size ?? 0), known.GetValueOrDefault(f))).ToList();
        trashId = result.FirstOrDefault(f => f.WellKnown == "deleteditems")?.Id;
        archiveId = result.FirstOrDefault(f => f.WellKnown == "archive")?.Id;
        return result;
    }

    static async Task<IMailFolder> OpenAsync(ImapClient c, string id, FolderAccess access, CancellationToken ct)
    {
        var folder = await c.GetFolderAsync(id, ct);
        if (!folder.IsOpen || folder.Access < access) await folder.OpenAsync(access, ct);
        return folder;
    }

    /// <summary>Every UID in a folder. Read-only (EXAMINE), so scanning never marks anything as read.</summary>
    public Task<UidList> UidsAsync(FolderRequest req, CancellationToken ct) => imap.RunAsync(async c =>
    {
        var folder = await OpenAsync(c, req.Folder, FolderAccess.ReadOnly, ct);
        var uids = await folder.SearchAsync(SearchQuery.All, ct);
        return new UidList(folder.UidValidity, uids.Select(u => u.Id).ToList());
    }, ct);

    /// <summary>What the scan needs from up to a few hundred mails, including their unsubscribe headers.</summary>
    public Task<FetchedMails> FetchAsync(FetchMailsRequest req, CancellationToken ct) => imap.RunAsync(async c =>
    {
        var folder = await OpenAsync(c, req.Folder, FolderAccess.ReadOnly, ct);
        if (folder.UidValidity != req.Validity) return new FetchedMails(true, []);
        var summaries = await folder.FetchAsync(req.Uids.Select(u => new UniqueId(req.Validity, u)).ToList(), ScanFields, ct);
        return new FetchedMails(false, summaries.Select(s => Mail(s, req.Folder, req.Validity)).ToList());
    }, ct);

    /// <summary>Applies an action. Mails missing from the answer were renumbered since the scan.</summary>
    public async Task<Applied> ApplyAsync(ApplyRequest req, CancellationToken ct)
    {
        var action = req.Action;
        if (action is not ("trash" or "delete" or "archive" or "read" or "unread")) throw new ApiException(400, "Unknown action.");
        if (action is "trash" or "archive" && trashId is null && archiveId is null) await AllFoldersAsync(ct);
        var target = action switch
        {
            "trash" => trashId ?? throw new ApiException(400, "This mailbox has no Trash folder. Pick \"delete right away\" instead."),
            "archive" => archiveId ?? throw new ApiException(400, "This mailbox has no Archive folder."),
            _ => null,
        };
        var done = new List<AppliedMail>();
        var known = req.Ids.Select(id => (Id: id, Mail: ParseId(id))).Where(x => x.Mail is not null).Select(x => (x.Id, Mail: x.Mail!.Value));
        foreach (var group in known.GroupBy(x => x.Mail.Folder))
        {
            var mails = group.ToList();
            var (applied, moved) = await imap.RunAsync(async c =>
            {
                var folder = await OpenAsync(c, group.Key, FolderAccess.ReadWrite, ct);
                var uids = mails.Where(x => x.Mail.Validity == folder.UidValidity).Select(x => x.Mail.Uid).ToList();
                UniqueIdMap? map = null;
                if (uids.Count > 0)
                {
                    switch (action)
                    {
                        case "read" or "unread":
                            var store = action == "read" ? StoreAction.Add : StoreAction.Remove;
                            await folder.StoreAsync(uids, new StoreFlagsRequest(store, MessageFlags.Seen) { Silent = true }, ct);
                            break;
                        case "delete":
                            await folder.StoreAsync(uids, new StoreFlagsRequest(StoreAction.Add, MessageFlags.Deleted) { Silent = true }, ct);
                            // Without UIDPLUS, EXPUNGE also removes mail another app flagged as deleted in this folder.
                            if (c.Capabilities.HasFlag(ImapCapabilities.UidPlus)) await folder.ExpungeAsync(uids, ct);
                            else await folder.ExpungeAsync(ct);
                            break;
                        default:
                            map = await folder.MoveToAsync(uids, await c.GetFolderAsync(target!, ct), ct);
                            break;
                    }
                }
                return (uids.Select(u => u.Id).ToHashSet(), map);
            }, ct);

            foreach (var (id, mail) in mails.Where(x => applied.Contains(x.Mail.Uid.Id)))
            {
                // Without UIDPLUS the server doesn't say the new UID; the mail can be acted on again after a scan.
                var newId = action != "archive" ? null
                    : moved is { } m && m.TryGetValue(mail.Uid, out var to) ? MailId(target!, to.Validity, to.Id) : "";
                done.Add(new AppliedMail(id, newId));
            }
        }
        return new Applied(done);
    }

    public Task<MailBody> BodyAsync(BodyRequest req, CancellationToken ct)
    {
        var id = ParseId(req.Id) ?? throw new ApiException(409, "Scan again to open this mail.");
        return imap.RunAsync(async c =>
        {
            var folder = await OpenAsync(c, id.Folder, FolderAccess.ReadOnly, ct);
            if (folder.UidValidity != id.Validity) throw new ApiException(409, "This folder changed since the scan. Scan again.");
            var fields = new FetchRequest(MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.BodyStructure);
            var summary = (await folder.FetchAsync([id.Uid], fields, ct)).FirstOrDefault() ?? throw new ApiException(404, "That mail is gone.");
            var part = (BodyPart?)summary.HtmlBody ?? summary.TextBody;
            var text = part is null ? null : await folder.GetBodyPartAsync(id.Uid, part, ct) as TextPart;
            var envelope = summary.Envelope;
            return new MailBody(envelope?.Subject ?? "", Addresses(envelope?.From), Addresses(envelope?.To, envelope?.Cc),
                text?.Text ?? "", text != null && part == summary.HtmlBody);
        }, ct);
    }

    /// <summary>The quota when the server supports the QUOTA extension, folder sizes when it supports STATUS=SIZE.</summary>
    public async Task<StorageReport> StorageAsync(CancellationToken ct)
    {
        var folders = (await AllFoldersAsync(ct)).Where(f => f.WellKnown != "all").ToList();   // "All mail" repeats every other folder
        var (limit, usage) = await imap.RunAsync(async c =>
        {
            if (!c.Capabilities.HasFlag(ImapCapabilities.Quota)) return ((long?)null, (long?)null);
            try
            {
                var quota = await c.Inbox.GetQuotaAsync(ct);
                return ((long?)quota.StorageLimit * 1024, (long?)quota.CurrentStorageSize * 1024);
            }
            catch (ImapCommandException)
            {
                return ((long?)null, (long?)null);
            }
        }, ct);
        var sized = folders.Any(f => f.Size > 0);
        var trash = folders.FirstOrDefault(f => f.WellKnown == "deleteditems");
        return new StorageReport(
            limit,
            usage ?? (sized ? folders.Sum(f => f.Size) : null),
            folders.OrderByDescending(f => f.Size).ThenByDescending(f => f.Total)
                .Select(f => new StoragePart(f.Path, sized ? f.Size : null, f.Total)).ToList(),
            new StoragePart(trash?.Path ?? "Trash", sized ? trash?.Size : null, trash?.Total ?? 0),
            limit is null ? "Your mail server doesn't tell apps your storage limit." : null);
    }

    public async Task<EmptiedTrash> EmptyTrashAsync(CancellationToken ct)
    {
        if (trashId is null) await AllFoldersAsync(ct);
        if (trashId is not { } trash) return new EmptiedTrash(0);
        var count = await imap.RunAsync(async c =>
        {
            var folder = await OpenAsync(c, trash, FolderAccess.ReadWrite, ct);
            var n = folder.Count;
            if (n == 0) return 0;
            await folder.StoreAsync(UniqueIdRange.All, new StoreFlagsRequest(StoreAction.Add, MessageFlags.Deleted) { Silent = true }, ct);
            await folder.ExpungeAsync(ct);
            return n;
        }, ct);
        return new EmptiedTrash(count);
    }

    /// <summary>A mail for the scan. The page parses the unsubscribe headers, the same way for every service.</summary>
    static ScannedMail Mail(IMessageSummary s, string folder, uint validity)
    {
        var from = s.Envelope?.From?.Mailboxes.FirstOrDefault();
        return new ScannedMail(
            MailId(folder, validity, s.UniqueId.Id),
            from?.Address?.Trim().ToLowerInvariant() ?? "",
            from?.Name?.Trim() ?? "",
            s.Envelope?.Subject ?? "",
            (s.InternalDate ?? s.Envelope?.Date)?.ToUnixTimeMilliseconds() ?? 0,
            s.Size ?? 0,
            s.Flags?.HasFlag(MessageFlags.Seen) == true,
            (s.Headers?["Content-Type"] ?? "").TrimStart().StartsWith("multipart/mixed", StringComparison.OrdinalIgnoreCase),
            s.Headers?["List-Unsubscribe"] ?? "",
            s.Headers?["List-Unsubscribe-Post"] ?? "");
    }

    static string Addresses(params InternetAddressList?[] lists) =>
        string.Join(", ", lists.OfType<InternetAddressList>().SelectMany(l => l.Mailboxes)
            .Select(m => m.Name is { Length: > 0 } n && !n.Equals(m.Address, StringComparison.OrdinalIgnoreCase) ? $"{n} <{m.Address}>" : m.Address));

    static string MailId(string folder, uint validity, uint uid) => $"{folder}{Separator}{validity}{Separator}{uid}";

    static (string Folder, uint Validity, UniqueId Uid)? ParseId(string id)
    {
        var last = id.LastIndexOf(Separator);
        var middle = last > 0 ? id.LastIndexOf(Separator, last - 1) : -1;
        if (middle < 0 || !uint.TryParse(id.AsSpan(middle + 1, last - middle - 1), out var validity) || !uint.TryParse(id.AsSpan(last + 1), out var uid))
            return null;
        return (id[..middle], validity, new UniqueId(validity, uid));
    }
}
