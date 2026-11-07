# Build HyzerTech by voice from the car

Hold the voice button on the Escape's steering wheel and say **"Build with Claude."** Siri asks what to build, you answer out loud, and Claude Code starts working on this repo in the cloud. When it's done there's a draft pull request waiting for you. Say **"Claude build status"** to hear what it did.

```
Steering-wheel voice button (hold)
  → Siri (CarPlay)
    → "Build with Claude" Shortcut on your iPhone
      → POST to a Claude Code scheduled task's API trigger
        → Cloud session clones HyzerTech, makes the change, opens a draft PR labeled `voice`
```

You don't need a custom CarPlay app for this. Claude's own iPhone app already has a CarPlay voice mode, but it only chats and can't run Claude Code. Third-party CarPlay voice apps also need an entitlement that Apple approves case by case. Siri plus a Shortcut works today with nothing to install.

Setup takes about 15 minutes, done once on your phone. You need a Claude Pro, Max, Team or Enterprise plan.

---

## 1. Create the scheduled task (about 5 min)

1. Open [claude.ai/code/routines](https://claude.ai/code/routines) and tap **New task** (it may say **New routine**). If you're asked how to create it, choose **Set up manually**.
2. **Name**: `Voice build`
3. **Prompt**: paste the whole of [`routine-prompt.md`](./routine-prompt.md).
4. **Trigger**: **API**.
5. **Repository**: `evan-delancey/HyzerTech`.
6. **Connectors**: remove them all. This task doesn't need any.
7. Tap **Create**. The **API token** dialog shows the token **once**, so copy it somewhere safe right away.
8. Open the task again, go to the API trigger, and copy the **Fire URL**. It looks like `https://api.anthropic.com/v1/claude_code/routines/trig_.../fire`.

**Test it before going further.** On the task's page, tap **Run now** and enter something small, such as `change the stats tab title to throw history`. A session should start, and a few minutes later a draft PR labeled `voice` should appear.

## 2. Build the "Build with Claude" Shortcut (about 5 min)

In the **Shortcuts** app on your iPhone, tap **+**, name the shortcut **Build with Claude**, and add these actions in order:

1. **Ask for Input**
   - Input type: **Text**
   - Prompt: `What should Claude build?`
2. **Choose from Menu**. Siri reads your words back so you can catch a bad transcription.
   - Prompt: `Send this to Claude: ` followed by the **Provided Input** variable
   - Options: `Send it` and `Cancel`
   - Under **Cancel**, add **Stop This Shortcut**.
   - Leave **Send it** empty and put the next actions after **End Menu**.
3. **Get Contents of URL**
   - URL: your **Fire URL**
   - Method: **POST**
   - Headers (tap **Add new header** for each):
     | Key | Value |
     |---|---|
     | `Authorization` | `Bearer ` + your token (for example `Bearer sk-ant-oat01-...`) |
     | `anthropic-beta` | `experimental-cc-routine-2026-04-01` |
     | `anthropic-version` | `2023-06-01` |
   - Request Body: **JSON**, with one field: key `text`, type **Text**, value **Provided Input**
4. **Get Dictionary Value**: get the value for `claude_code_session_url` in **Contents of URL**.
5. **If** **Dictionary Value** **has any value**
   - **Speak Text**: `Claude's on it. I'll have a pull request ready for you.`
   - **Otherwise**: **Speak Text**: `That didn't go through.` (Add **Show Result** with **Contents of URL** to see the error when you're parked.)
   - **End If**

Run it once from the Shortcuts app while parked to check it works.

> The token is stored inside this shortcut, so don't share the shortcut. If the token ever leaks, open the task at claude.ai/code/routines and tap **Regenerate**, then paste the new token into the header.

## 3. Use it in the Escape

1. Connect your phone to CarPlay.
2. **Press and hold** the voice button on the steering wheel until Siri appears. On SYNC, a quick press usually opens Ford's own voice commands instead.
3. Say **"Build with Claude."**
4. Siri asks "What should Claude build?" Say the change, for example: *"Make the mph number on the camera screen twice as big and turn it green when it's over 50."*
5. Siri reads it back. Say **"Send it."**

Follow-ups go on the same branch. Start the request with something like *"Also…"*, *"On the last one…"* or *"Fix that…"*, and Claude adds commits to your most recent voice PR instead of starting a new one.

You can watch a run live, or continue it by typing, in the Claude app under **Code**. Each run is listed on the task's page.

## 4. Optional: hear results with "Claude build status"

This shortcut reads the newest `voice` PR's title and first line aloud. Claude writes that line to be spoken.

1. Create a GitHub **fine-grained personal access token** at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → `HyzerTech`
   - Permissions: **Issues: Read** and **Pull requests: Read**
2. In Shortcuts, create a shortcut named **Claude build status**:
   1. **Get Contents of URL**
      - URL: `https://api.github.com/repos/evan-delancey/HyzerTech/issues?labels=voice&state=all&sort=updated&direction=desc&per_page=1`
      - Method: **GET**
      - Headers: `Authorization` = `Bearer ` + your GitHub token, and `Accept` = `application/vnd.github+json`
   2. **Get Item from List**: **First Item** of **Contents of URL**
   3. **If** **Item from List** **has any value**
      - **Get Dictionary Value**: `title` in **Item from List**
      - **Get Dictionary Value**: `body` in **Item from List**
      - **Split Text**: the body, by **New Lines**
      - **Get Item from List**: **First Item** of **Split Text**
      - **Speak Text**: `Latest build: ` + the title value + `. ` + the first line
      - **Otherwise**: **Speak Text**: `No voice builds yet.`
      - **End If**

If you hear the previous build, the new run is still working (runs usually take a few minutes).

---

## Good to know

- **Nothing reaches `master` on its own.** The task's prompt tells Claude to push only to `claude/voice-*` branches and to open **draft** PRs. Review and merge them when you're parked, then run your usual EAS build. For an extra guard, add a branch protection rule on `master` in GitHub.
- **Limits.** API fires are capped at 30 per hour for this task, and every run uses your Claude plan's usage.
- **Siri opens the Claude app instead of your shortcut?** Rename the shortcut to something without "Claude" in it, such as "Ship it", and use that phrase instead.
- **Siri doesn't respond when you hold the button.** Some SYNC owners fix this by removing the phone from SYNC, doing a SYNC master reset, restarting the phone and pairing again.
- **401 error.** The token is wrong or was regenerated, so paste the current one after `Bearer `.
- **The API is a research preview.** If Anthropic changes the `anthropic-beta` header version, update it in the shortcut. The current value is listed in the [scheduled tasks docs](https://code.claude.com/docs/en/routines#trigger-a-scheduled-task).
- **Just talking an idea through?** Open the Claude app on the CarPlay screen for a hands-free voice chat, then say "Build with Claude" when you're ready to build.
