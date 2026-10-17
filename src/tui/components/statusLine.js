/** Footer under the input: channel, mode, account, folder - plus module items. */
export function statusLine({ channel, mode, ghUser, cwd, notice, items = [], t }) {
  if (notice) return [`  ${t.yellow(notice)}`];
  const parts = [
    channel ? t.magenta(t.bold(`#${channel}`)) : t.yellow('no channel - /init'),
    mode === 'auto' ? t.yellow('⏵⏵ auto mode') : t.dim('ask mode'),
    ghUser ? t.dim(`GitHub ${ghUser}`) : null,
    t.dim(cwd),
    ...items.map((s) => t.dim(s)),
  ].filter(Boolean);
  return [`  ${parts.join(t.dim(' · '))}`, t.dim('  shift+tab mode · ctrl+o next agent · ? shortcuts')];
}
