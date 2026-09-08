# Smoke test

Everything in this app has been driven by a machine so far. Nobody has used it.

This is the list to work down before a release. It is ordered so that the steps that touch
nothing come first and the steps that write to your game come last, and every writing step
says how to put it back. Stop at the first thing that is wrong, rather than working around
it: a workaround is a bug someone else will meet without knowing to work around it.

Roughly twenty minutes, plus one RimWorld launch.

## Before you start

Copy `ModsConfig.xml` somewhere. The app backs it up itself before writing, and the backup
has been tested, but a copy you made is a copy you can find.

```
%USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Config\ModsConfig.xml
```

## 1. It opens and reads the install

- [ ] Install from the `.exe`. SmartScreen warns because the build is unsigned: More info, Run anyway.
- [ ] It reaches the Home tab without an error panel.
- [ ] The header counts match reality: installed, in modpack, and the game version.
- [ ] **Rescan** finishes and the numbers do not change.

Nothing here has written anything.

## 2. The Doctor tab says something true

- [ ] Findings appear, and the severity counts above them add up to the list.
- [ ] Click a severity to filter, click again to clear.
- [ ] Open a finding. The detail explains it in words you would use, not engine words.
- [ ] Anything under **Observations** should read as a fact about the install, not as work waiting. If any line there looks like a fault, that is a bug.
- [ ] **Check Harmony patches**. It should finish in seconds without launching anything.

## 3. The Session tab reads your last run

- [ ] It loads the current log and lists faults, worst first.
- [ ] Switch to **Previous run**. It should load a different log, not the same one.
- [ ] Open a fault with a stack trace. The frames that name a mod should be near the top.
- [ ] **Copy report**, paste it somewhere. It should be readable by a person, lead with the environment, and carry a severity breakdown.

## 4. A repair, and putting it back

Pick the smallest repair the Doctor offers.

- [ ] Press the repair. It shows a **plan** before it does anything.
- [ ] Read the plan. It should name the exact files it will touch.
- [ ] Apply it. The transcript lists one line per file.
- [ ] **Roll it back.** Check on disk that the file is as it was, or gone if it was created.

If rollback does not restore it, stop. That is the one promise the app cannot break.

## 5. Applying to the game

- [ ] **Apply to game** is green with a number when the modpack differs, and disabled when it does not.
- [ ] Press it. The confirmation says how many entries it will write.
- [ ] After it finishes, the button goes disabled and the count is gone.
- [ ] Open `ModsConfig.xml` and confirm the order is what the app showed.

## 6. Playing

- [ ] **Play**. The game starts and the app stays on the tab you were on.
- [ ] Go to Performance. The console should be filling in.
- [ ] Load a colony and let it run for a minute.
- [ ] Quit RimWorld normally. The run should be recorded on Home under what RimDoc+ did.

## 7. Playing badly, on purpose

- [ ] **Play** again, then kill RimWorld from Task Manager rather than quitting.
- [ ] An amber strip should appear saying how it ended, wherever you are.
- [ ] **Show me** takes you to the console.

## 8. The companion mod, if you want tick numbers

- [ ] Performance tab, **Install it in the game**, then **Add it to the load order**.
- [ ] **Apply to game**, then play and load a colony.
- [ ] The table fills with per-mod tick cost.
- [ ] **Delete it from the game** removes it. RimWorld will report it missing until you apply a modpack again, which is expected and the panel says so.

## What counts as a failure

Anything that writes when it said it would not. Anything that cannot be rolled back. Any
number that disagrees with the same number elsewhere in the app. Any screen that tells you
to do something the app could have done. Any sentence that describes behaviour the app no
longer has.

The last one is worth naming: two of the defects found in this app were true sentences that
had quietly stopped being true.
