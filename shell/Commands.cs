// Mail Cleaner, Copyright (C) 2026 XxSeRyIxX. SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms under AGPL section 7 apply: see NOTICE.

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace MailCleaner;

/// <summary>What the page can ask the shell for (app/native.js), and the answers.</summary>
internal sealed class Commands(SignIn signIn, ImapStore store, ImapConnection connection, ImapBridge imap)
{
    private static readonly ShellJson J = ShellJson.Default;

    public async Task<JsonNode?> RunAsync(string cmd, JsonElement args, CancellationToken ct)
    {
        switch (cmd)
        {
            case "open":
                Desktop.Open(Read(args, J.OpenRequest).Url);
                return null;
            case "save":
                return Node(Desktop.Save(Read(args, J.SaveRequest)), J.Saved);
            case "lang":
                Texts.Use(args.ValueKind == JsonValueKind.Object && args.TryGetProperty("lang", out JsonElement lang)
                    && lang.ValueKind == JsonValueKind.String ? lang.GetString() : null);
                return null;

            case "auth.signIn":
                return await signIn.SignInAsync(Read(args, J.SignInRequest), ct);
            case "auth.renew":
                return await signIn.RenewAsync(Read(args, J.ProviderRequest).Provider, ct);
            case "auth.signOut":
                await signIn.SignOutAsync(Read(args, J.ProviderRequest).Provider, ct);
                return null;

            case "imap.state":
                return Node(store.State(), J.ImapState);
            case "imap.lookup":
                return Node(await ImapServers.FindAsync(Read(args, J.LookupRequest).Email, ct), J.ImapSuggestion);
            case "imap.setup":
                await store.SetupAsync(Read(args, J.ImapSetup), ct);
                await connection.ResetAsync();
                return null;
            case "imap.logout":
                store.SignOut();
                await connection.ResetAsync();
                return null;
            case "imap.folders":
                return Node(await imap.FoldersAsync(ct), J.FolderList);
            case "imap.uids":
                return Node(await imap.UidsAsync(Read(args, J.FolderRequest), ct), J.UidList);
            case "imap.fetch":
                return Node(await imap.FetchAsync(Read(args, J.FetchMailsRequest), ct), J.FetchedMails);
            case "imap.apply":
                return Node(await imap.ApplyAsync(Read(args, J.ApplyRequest), ct), J.Applied);
            case "imap.body":
                return Node(await imap.BodyAsync(Read(args, J.BodyRequest), ct), J.MailBody);
            case "imap.storage":
                return Node(await imap.StorageAsync(ct), J.StorageReport);
            case "imap.emptyTrash":
                return Node(await imap.EmptyTrashAsync(ct), J.EmptiedTrash);

            default:
                throw new ApiException(400, Texts.L("Unknown command.", "Orden desconocida."));
        }
    }

    private static T Read<T>(JsonElement args, JsonTypeInfo<T> info) =>
        args.ValueKind == JsonValueKind.Object && args.Deserialize(info) is { } value ? value
            : throw new ApiException(400, Texts.L("Bad request.", "Petición incorrecta."));

    private static JsonNode? Node<T>(T value, JsonTypeInfo<T> info) => JsonSerializer.SerializeToNode(value, info);
}
