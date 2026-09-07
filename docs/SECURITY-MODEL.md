# What this app can touch

RimDoc+ deletes folders inside your game install. That is the point of it, and it is also the
reason this page exists: you should be able to find out exactly what it is able to do without
reading the whole codebase.

Everything below is checkable. Each claim names where in the source it is enforced.

## The short version

- It writes to your RimWorld install, its config folder, and two folders in your home
  directory. Nowhere else.
- It makes exactly one kind of network request, to fetch a shared log from a gist link you
  pasted, and only when you press Fetch. Nothing else ever leaves the machine.
- It copies every file to `<file>.rimdocbak` before changing it, and every run is undoable.
- It runs six external programs: RimWorld, `steam.exe`, `tasklist`, `reg`, `taskkill`, and its
  own bundled patch probe. It also loads your game's own `steam_api64.dll` to subscribe to a
  Workshop item, which is the one thing it does that Steam sees as RimWorld.
- It sends nothing anywhere. There is no telemetry, no analytics, no crash reporter.

## The command boundary

The webview cannot touch the filesystem. Everything it can ask the shell to do is one of
twenty-one commands registered in `src-tauri/src/lib.rs`, and that list is the complete surface.
If a capability is not on it, the app does not have it.

### The five that write

| Command                           | What it can change                                           |
| --------------------------------- | ------------------------------------------------------------ |
| `run_file_actions`                | Carries out a repair plan. Backs up every target first.      |
| `apply_mods_config`               | Writes the game's `ModsConfig.xml`.                          |
| `rollback`                        | Restores `.rimdocbak` copies beside the paths a run touched. |
| `vault_capture` / `vault_restore` | Copies mod folders into and out of `~/RimDoc-Vault`.         |
| `vault_forget`                    | Deletes one build from the vault.                            |

`run_file_actions` is the only general-purpose write, and it is not general-purpose in the
usual sense: it understands exactly five verbs, listed in
[ARCHITECTURE.md](ARCHITECTURE.md#repairs-are-plans-not-actions). There is no "run arbitrary
command" and no "write this path with these bytes" that the analysis layer can reach for.

### The eight that only read

`scan_install`, `read_session_log`, `list_saves`, `read_mod_preview`, `hash_mod`,
`vault_list`, `is_steam_running`, `is_game_running`.

`read_session_log` takes a flag saying which of the game's two logs to read, not a path. No
command anywhere takes a path to read, because that would be a general file-read primitive
and the point of a twenty-one-command surface is that there is not one.

`probe_patches` takes mod folders and reads the assemblies under them. It only ever reads,
and the program it runs to do so reads .NET metadata rather than loading an assembly, so no
mod code executes. Loading would fire static constructors, which is running someone's mod to
find out whether their mod works.

### The one that reaches the network

`fetch_shared_log`. Covered in full under [Network](#network).

`read_mod_preview` deserves a note, because it is the one command that hands file contents
back to the webview. It will only return a file named like a mod banner from inside a folder
the scan already found. It is an allowlist, not a sanitiser, because a sanitiser is a thing
you can be subtly wrong about, and there is a test named
`only_a_mod_banner_can_be_read_back` that holds it to that.

### The five that control processes

`launch_game`, `launch_supervised`, `stop_game`, `stop_steam`, `start_steam`.

`stop_game` only ever stops the process this app started, by the pid it stored when it
started it. It never kills by image name, because that would take down a copy of the game the
app did not launch.

## What it runs

Six external programs, all of them either yours, Windows', or shipped in this app. Nothing
else is ever run:

| Program               | Why                                                                                      | Where                                       |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| `RimWorldWin64.exe`   | You pressed Play.                                                                        | `launch_game`, `launch_supervised`          |
| `steam.exe -shutdown` | A Workshop repair needs Steam closed, and you pressed the button that says so.           | `stop_steam`                                |
| `steam.exe`           | Starting it again afterwards.                                                            | `start_steam`                               |
| `tasklist`            | Is Steam running, is the game still up, how much memory is it using.                     | `image_running`, `memory_mb`                |
| `reg query`           | Where Steam is installed, and whether it is running a game.                              | `steam_exe_from_registry`, `running_app_id` |
| `taskkill`            | Stopping a supervised run, by pid.                                                       | `stop_game`                                 |
| `rimdoc-patchprobe`   | Reading mod assemblies to check Harmony targets. Bundled with the app, never downloaded. | `probe_patches`                             |

All of them are spawned through `console_command`, which sets `CREATE_NO_WINDOW` so they do
not flash a console window over your game.

Nothing is ever passed to a shell. Every one of these is an argument vector handed straight to
`CreateProcess`, so there is no string a mod name could be smuggled through.

## Where it writes

| Path                                      | What goes there                                                    |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Your RimWorld install                     | Repairs, and only what a plan named.                               |
| `.../LocalLow/Ludeon Studios/.../Config/` | `ModsConfig.xml`, when you apply a load order.                     |
| `<any touched file>.rimdocbak`            | The copy taken before the first change to it.                      |
| `~/RimDoc-Backups/original-version/`      | The whole Config folder, copied once, before anything.             |
| `~/RimDoc-Vault/`                         | Mod builds you asked it to keep.                                   |
| Browser local storage                     | Modpacks, run history, settings. Cleared by the reset in Settings. |

That is the complete list. It does not write to Program Files outside the Steam folders it was
pointed at, to the registry, to startup entries, or to any system location.

## Undoing things

Two layers, and they are independent.

**Per file.** `backup_once` copies a path to `<path>.rimdocbak` before the first change. It
never retakes a backup: the copy worth having is the one from before anything happened, and
retaking it on a second run would overwrite a good copy with a half-repaired one.

**Per run.** Before any action, the whole Config directory is copied to
`~/RimDoc-Backups/original-version`, guarded by a `.complete` marker so an interrupted copy is
never mistaken for a finished one.

Every run has an **Undo this run** button, and every plan can be downloaded as a rollback
script so you can undo it later, from outside the app, without RimDoc+ running at all.

## Network

**The app makes exactly one request, and only when you ask for it.**

RimWorld's **Share logs** button uploads your log to a gist and writes nothing to disk, so
there is no local file to read instead. `fetch_shared_log` fetches that gist when you paste
the link and press Fetch.

What holds it to that:

- **Two hosts, and no others.** `gist.github.com` and `gist.githubusercontent.com`, matched on
  the whole host segment and never on a suffix. `gist.github.com.example.com` and
  `gist.github.com@example.com` are both refused, and there are tests named for exactly those.
- **HTTPS only.** An `http://` or `file://` link is refused before anything is opened.
- **Nothing goes with it.** The request carries the URL you pasted. No identifier of your
  machine, no mod list, no path.
- **You press the button.** Nothing fetches on startup, on a scan, or on a timer.

If you would rather make no request at all, **Copy to clipboard** sits beside **Share logs**
in the same debug window and puts the identical text on your clipboard. Paste it into the
**Pasted** source and the app reads it with no network involved. That path is always there.

Everything else stays local. There is no telemetry, no analytics, no crash reporting, no
update check, and nothing is fetched about your mods:

```bash
grep -rn "fetch(\|XMLHttpRequest\|WebSocket" --include="*.ts" --include="*.tsx" src/
```

comes back empty, because the frontend cannot reach the network at all; the one request lives
behind a shell command that refuses anything but a gist.

Three `https://` strings do appear in `src/`, in `library.ts` and `repairs.ts`. All three build
the address of a Steam Workshop page for a link you can click. They are link targets that open
in your own browser, never something the app requests.

The Library tab's Workshop columns are read from a cache file, and that file is filled by a
**separate command you run yourself**:

```bash
pnpm workshop          # fetch anything missing or older than a week
pnpm workshop --force  # refetch everything
```

`scripts/workshop.mjs` is a standalone Node script. It calls exactly one endpoint,
`GetPublishedFileDetails`, which is anonymous: no API key, no Steam account, no credential of
any kind. What leaves the machine is a list of Workshop file ids, which are the public
identifiers of public mods. The results cache to a gitignored file with a one-week TTL.

The app works fully without ever running it, and cannot run it for you.

There is no telemetry, no analytics, no crash reporting, and no update check.

## Subscribing to a Workshop item

There is a **Subscribe** button on a finding about a missing mod, and it is the only thing
here that presents this app to Steam **as RimWorld**.

That is not a shortcut taken for convenience. Subscribing goes through the Steamworks API,
that API authenticates by app id, and no `steam://` URL will do it: the protocol can open a
Workshop page and nothing else. So there is no version of this feature that does not do it.

What that means, plainly:

- **While the call runs, Steam shows you as playing RimWorld.** Your friends can see it. It
  lasts seconds, but it is real and it is the reason this is said on the button as well as
  here.
- It **loads your own copy** of `steam_api64.dll` from your RimWorld install. Nothing of
  Valve's is redistributed with this app, and the version used is the one your game was built
  against.
- It **refuses while a game is running.** Two processes initialising the API under one app id
  is not something this can test on every machine, and the cost of being wrong is your
  session.
- It needs Steam running and signed in, and says so rather than failing quietly.
- It asks Steam to subscribe and nothing more. It does not download, unsubscribe, or touch
  anything else on your account.

The Workshop page button is still there and still does nothing but open a page.

This reverses a position this document previously stated. It was changed deliberately, by the
owner, after the trade-off above was put to him in these words.

## Closing Steam

One button closes Steam, applies a repair, and starts it again. It exists because Steam keeps
its record of downloaded Workshop items in memory and rewrites the file when it exits, so
editing that file while Steam is up achieves nothing at all.

What it will not do:

- It refuses outright if Steam is running a game, read from Steam's own `RunningAppID`.
  `steam.exe -shutdown` is headless and cannot raise Steam's usual "a game is running" prompt,
  so without this check it would take a live session down with no warning and no save.
- It uses Steam's own shutdown, never a kill. A kill is precisely the case where the record
  never gets written, which would leave the repair editing a stale file.
- It waits for Steam to actually be gone before writing, and treats "could not tell" as still
  running rather than guessing.
- It starts Steam again whether or not the repair worked, and only if this run was what closed
  it. A Steam you had already shut stays shut.

## What it deliberately will not do

- **Unsubscribe on your behalf.** Removing something from your account is not a repair.
- **Edit your saves.** It reads the mod list out of the header and nothing else.
- **Touch mod code.** No assembly is patched, rewritten or injected.
- **Auto-repair on its own.** Every write is behind a button you pressed, and every plan can
  be read in full before you press it.

## Reporting something

If you find a way to make RimDoc+ write outside the paths on this page, that is a real
vulnerability and worth telling me about privately first. The contact address is in
[COMMERCIAL.md](../COMMERCIAL.md).
