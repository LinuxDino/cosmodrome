# GitHub setup guide

Part A sets up **two GitHub accounts** (work + private) with cosmodrome. Part B **publishes this project** to GitHub and npm.

---

## Part A – one GitHub account per profile

### 1. Install the GitHub CLI
```bash
brew install gh                 # macOS
# Debian/Ubuntu: see https://github.com/cli/cli#installation
```

### 2. Create the profiles
```bash
cosmo init
# work:    git email you@company.com, workdir ~/work
# private: git email you@example.com, workdir ~/private
```
The `workdir` is what makes channels switch automatically: anything under `~/work` uses the *work* account.

### 3. Sign in once per profile
```bash
cosmo login work        # opens gh auth login with the work profile's own config folder
cosmo login private
```
or `/login` in the interface. In the gh prompts choose **GitHub.com → HTTPS → Login with a web browser**. Make sure the browser is signed in to the matching account; a private window helps for the second one.

### 4. Check it
```bash
cosmo status                                               # GitHub user per profile
( eval "$(cosmo env work)"; gh auth status; git config user.email )   # what "work" really uses
```
In the interface: `!gh auth status` and `!git config user.email` show what the current channel uses.

### How git authentication works
For every launch cosmodrome writes `~/.local/share/cosmodrome/profiles/<name>/gitconfig` and points `GIT_CONFIG_GLOBAL` at it. That file:
1. includes your normal `~/.gitconfig` (aliases, editor, etc. keep working),
2. sets `user.name` / `user.email` of the profile,
3. sets `gh auth git-credential` as the HTTPS credential helper, so `git push` uses the profile's gh login.

Clone with HTTPS (`https://github.com/org/repo.git`) and pushes go out as the right account automatically.

### Prefer SSH?
Use one key per account and host aliases in `~/.ssh/config`:
```
Host github-work
  HostName github.com
  IdentityFile ~/.ssh/id_ed25519_work
  IdentitiesOnly yes
Host github-private
  HostName github.com
  IdentityFile ~/.ssh/id_ed25519_private
  IdentitiesOnly yes
```
Then clone with `git@github-work:org/repo.git`. Note: inside Antigravity (`agy`) sessions `~/.ssh` is hidden, so HTTPS is easier there.

### GitHub Enterprise
`cosmo profile set work --github-host github.mycompany.com` sets `GH_HOST` and the credential helper for that host.

---

## Part B – publish cosmodrome to GitHub and npm

### 1. Create the repository
```bash
cd cosmodrome
git init && git add . && git commit -m "cosmodrome 0.2.0"
gh repo create cosmodrome --public --source . --push      # or --private
```
Update `repository`, `homepage` and `bugs` in `package.json` if you add them.

### 2. CI
`.github/workflows/ci.yml` runs `npm test` on Ubuntu and macOS with Node 18, 20, and 22 for every push and pull request.

### 3. First npm release (manual, once)
npm's trusted publishing needs an existing package, so the first version is published from your machine:
```bash
npm login
npm publish --access public
```
Check that the name is still free first: `npm view cosmodrome` should return 404. If it's taken, rename in `package.json` (e.g. `@your-scope/cosmodrome`).

### 4. Trusted publishing (no npm token in GitHub)
1. On npmjs.com → package **Settings** → **Trusted Publisher** → **GitHub Actions**: enter your user/org, the repo, and the workflow file `release.yml`.
2. Optional, but recommended: disallow token-based publishing for the package.
3. `.github/workflows/release.yml` already has `permissions: id-token: write` and runs `npm publish --provenance --access public`. It updates npm first, because trusted publishing needs a recent npm CLI.

### 5. Release
```bash
npm version minor            # bumps package.json, commits, tags v0.3.0
git push --follow-tags       # the tag triggers release.yml → npm publish with provenance
```
Docs: https://docs.npmjs.com/trusted-publishers

### Recommended repo settings
- Protect `main`: require the CI check to pass, require PRs.
- Enable Dependabot alerts (only for GitHub Actions, since the package has no runtime dependencies).
- Add topics: `cli`, `ai-agents`, `claude-code`, `copilot`, `tmux`.
