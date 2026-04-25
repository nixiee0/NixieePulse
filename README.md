# :warning: THIS EXTENSION IS CURRENTLY IN THE ALPHA TESTING PHASE. USE IT AT YOUR OWN RISK.

# :warning: IT IS NOT RECOMMENDED TO OPEN MORE THAN ONE VSCODE WINDOW. YOU MAY LOSE YOUR STATISTICAL DATA.

---

# NixieePulse

Local coding time tracker for VS Code with JSON storage, dashboard, and GitHub profile SVG sync.

## Features

- Tracks active coding time locally.
- Tracks time by language, project, and file.
- Can optionally track time by file.
- Ignores idle time.
- Stores stats in a local JSON file.
- Shows today's tracked time in the VS Code status bar.
- Provides an internal dashboard with daily, weekly, language, and project stats.
- Can export stats JSON.
- Can sync a generated `assets/coding-activity.svg` card to a GitHub profile README repository.

## Commands

- `NixieePulse: Open Dashboard`
- `NixieePulse: Refresh Dashboard`
- `NixieePulse: Show Today's Stats`
- `NixieePulse: Open Stats JSON`
- `NixieePulse: Export Stats JSON`
- `NixieePulse: Reset Today's Stats`
- `NixieePulse: Sync GitHub Profile Now`
- `NixieePulse: Set GitHub Token`
- `NixieePulse: Clear GitHub Token`
- `NixieePulse: Open GitHub Sync Setup Guide`

## GitHub profile block

Put this in your profile README:

```md
## 📊 Coding Activity

<!-- NIXIEEPULSE:START -->
<p align="center">
  <img src="./assets/coding-activity.svg" alt="Coding Activity" width="1080" />
</p>
<!-- NIXIEEPULSE:END -->
```

## Recommended settings

```json
{
  "nixieepulse.githubProfile.enabled": true,
  "nixieepulse.githubProfile.owner": "your-github-name",
  "nixieepulse.githubProfile.repo": "your-github-repo",
  "nixieepulse.githubProfile.branch": "main",
  "nixieepulse.githubProfile.readmePath": "README.md",
  "nixieepulse.githubProfile.mode": "svg",
  "nixieepulse.githubProfile.svgPath": "assets/coding-activity.svg",
  "nixieepulse.githubProfile.autoSyncMinutes": 30,
  "nixieepulse.githubProfile.syncOnExit": true,
  "nixieepulse.githubProfile.maxLanguages": 6
}
```

## Development

```bash
npm install
npm run compile
```

Run in VS Code Extension Development Host with `F5`.

Build VSIX:

```bash
npm run package
```
