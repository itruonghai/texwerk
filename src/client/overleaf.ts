import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { OverleafInfo } from '@shared/protocol.ts';
import { themeMode } from './codeEditor.ts';
import { api, confirmDialog, dialog, h, toast } from './ui.ts';

/**
 * The Overleaf link in the browser: a chip in the toolbar that says how the
 * link is doing, and the dialog behind "Overleaf…" — link (compare both
 * sides first, then pick a side for each file that differs), give a new
 * session cookie, reconnect, unlink. The server does the syncing
 * (src/server/overleaf/link.ts); the cookie is sent once and never comes back.
 */

interface LinkPreview {
  name: string;
  account: string;
  same: string[];
  toTexwerk: string[];
  toOverleaf: string[];
  differ: Array<{ path: string; kind: 'text' | 'binary'; texwerk?: string; overleaf?: string }>;
}

/** Overleaf's version as the original, TeXWerk's on top: what keeping TeXWerk would change on Overleaf. */
function showDiff(host: HTMLElement, overleaf: string, texwerk: string): EditorView {
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc: texwerk,
      extensions: [
        lineNumbers(),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        unifiedMergeView({ original: overleaf, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged: { margin: 2, minSize: 4 } }),
        themeMode(),
      ],
    }),
  });
}

const STATUS_TEXT: Record<OverleafInfo['status'], string> = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
  expired: 'cookie expired',
  lost: 'no access',
};
const STATUS_DOT: Record<OverleafInfo['status'], string> = { connecting: '', live: 'ok', reconnecting: 'warn', expired: 'bad', lost: 'bad' };

const COOKIE_HELP = 'In a browser signed in to Overleaf, open the project, then the developer tools (F12) → Application (Storage in Firefox) → Cookies → overleaf.com, and copy the value of overleaf_session2. It is the key to that Overleaf account: it is kept on this server only, never shown again, and never mirrored or committed. Use your own account.';

export interface OverleafControls {
  /** Show the dialog. */
  open(): void;
  /** Read the state again (after the connection to the server came back). */
  refresh(): void;
  /** A server event about the link. */
  update(info: OverleafInfo | null): void;
}

export function setupOverleaf(project: string, button: HTMLButtonElement, chip: HTMLButtonElement): OverleafControls {
  const q = `?project=${encodeURIComponent(project)}`;
  let info: OverleafInfo | null = null;
  let canManage = false;
  let rerender: (() => void) | null = null;

  const paint = () => {
    chip.hidden = !info;
    if (info) {
      chip.replaceChildren(h('span', { class: `dot ${STATUS_DOT[info.status]}` }), `Overleaf · ${STATUS_TEXT[info.status]}`);
      chip.title = info.conflicts.length ? `${info.message} Conflicts to resolve in: ${info.conflicts.join(', ')}` : info.message;
      chip.classList.toggle('attention', info.status === 'expired' || info.status === 'lost' || info.conflicts.length > 0);
    }
    rerender?.();
  };

  /** Take a state unless it is older than the one shown (a reply can cross a newer event). */
  const accept = (next: OverleafInfo | null) => {
    if (next && info && next.seq < info.seq) return;
    info = next;
    paint();
  };

  const refresh = () => {
    void api<{ info: OverleafInfo | null; canManage: boolean }>('GET', `/api/overleaf${q}`).then((r) => {
      canManage = r.canManage;
      accept(r.info);
    }).catch(() => {});
  };

  const open = () => {
    dialog((close) => {
      const body = h('div', {});
      // A status change refreshes the status lines only, so nothing typed
      // into the dialog is lost; linking or unlinking rebuilds it.
      let shown: 'linked' | 'form' | null = null;
      let refreshStatus: (() => void) | null = null;
      rerender = () => {
        const mode = info ? 'linked' : 'form';
        if (mode === shown && refreshStatus) { refreshStatus(); return; }
        shown = mode;
        if (info) {
          const view = linkedView(close);
          refreshStatus = view.refresh;
          body.replaceChildren(...view.nodes);
        } else {
          refreshStatus = null;
          body.replaceChildren(...linkForm(close));
        }
      };
      rerender();
      return [h('h2', {}, 'Overleaf'), body];
    }, { wide: true, onClose: () => { rerender = null; } });
  };

  const linkedView = (close: () => void): { nodes: Node[]; refresh: () => void } => {
    const out = h('pre', { class: 'out', hidden: true });
    const run = async (label: string, work: () => Promise<{ info: OverleafInfo | null }>) => {
      out.hidden = false;
      out.classList.remove('bad');
      out.textContent = `${label}…`;
      try {
        accept((await work()).info);
        out.textContent = `${label}: done.`;
      } catch (err) {
        out.classList.add('bad');
        out.textContent = (err as Error).message;
      }
    };
    const cookie = h('input', { type: 'password', placeholder: 'overleaf_session2 value', autocomplete: 'off', spellcheck: 'false' });
    const kv = h('div', { class: 'kv' });
    const cookieTitle = h('h3', {});
    const save = h('button', { onclick: () => void run('Saving the cookie', () => api('POST', `/api/overleaf/cookie${q}`, { cookie: cookie.value })) }, 'Save');
    const refresh = () => {
      const i = info;
      if (!i) return;
      kv.replaceChildren(
        h('span', {}, 'status'), h('b', { class: `ol-status ${STATUS_DOT[i.status]}` }, STATUS_TEXT[i.status]),
        h('span', {}, ''), h('span', {}, i.message),
        h('span', {}, 'Overleaf'), h('a', { href: i.url, target: '_blank', rel: 'noopener' }, i.url),
        h('span', {}, 'linked by'), h('b', {}, i.linkedBy || '—'),
        ...(i.conflicts.length ? [h('span', {}, 'conflicts'), h('b', { class: 'bad-text' }, `Both sides changed the same lines while apart in ${i.conflicts.join(', ')}. Both versions are in the text between %<<<<<<< and %>>>>>>> lines; keep the right one.`)] : []));
      cookieTitle.textContent = i.status === 'expired' ? 'Paste a new session cookie' : 'Session cookie';
      save.classList.toggle('primary', i.status === 'expired');
    };
    refresh();
    const nodes = [
      h('p', { class: 'muted' }, 'This project is linked to an Overleaf project. Text edits go both ways as they are typed; new, renamed and deleted files and comment threads go across too. Edits from Overleaf show as ', h('b', {}, 'Name · Overleaf'), ' in Authors and History.'),
      kv,
      ...(canManage ? [
        cookieTitle,
        h('p', { class: 'muted' }, COOKIE_HELP),
        h('div', { class: 'row' }, cookie, save),
      ] : [h('p', { class: 'muted' }, 'Only the project\'s owner can change the link.')]),
      out,
      h('div', { class: 'actions' },
        ...(canManage ? [
          h('button', { class: 'danger', onclick: () => void confirmDialog('Unlink from Overleaf?', 'Syncing stops. The files stay as they are, here and on Overleaf, and the session cookie is deleted from this server.', 'Unlink', true)
            .then((ok) => { if (ok) void run('Unlinking', () => api('POST', `/api/overleaf/unlink${q}`)); }) }, 'Unlink'),
          h('button', { onclick: () => void run('Reconnecting', () => api('POST', `/api/overleaf/reconnect${q}`)) }, 'Reconnect now'),
        ] : []),
        h('span', { class: 'spacer' }),
        h('button', { onclick: close }, 'Close')),
    ];
    return { nodes, refresh };
  };

  const linkForm = (close: () => void): Node[] => {
    if (!canManage) {
      return [h('p', {}, 'This project is not linked to Overleaf. Only its owner can link it.'), h('div', { class: 'actions' }, h('button', { onclick: close }, 'Close'))];
    }
    const url = h('input', { class: 'ol-url', placeholder: 'https://www.overleaf.com/project/…', spellcheck: 'false' });
    const cookie = h('input', { type: 'password', placeholder: 'overleaf_session2 value', autocomplete: 'off', spellcheck: 'false' });
    const out = h('pre', { class: 'out', hidden: true });
    const plan = h('div', { class: 'ol-plan' });
    const compareBtn = h('button', { class: 'primary' }, 'Compare');
    const fail = (err: unknown) => {
      out.hidden = false;
      out.classList.add('bad');
      out.textContent = (err as Error).message;
    };
    compareBtn.addEventListener('click', () => {
      out.hidden = false;
      out.classList.remove('bad');
      out.textContent = 'Reading both sides… (nothing changes yet)';
      plan.replaceChildren();
      compareBtn.disabled = true;
      void api<LinkPreview>('POST', `/api/overleaf/preview${q}`, { url: url.value, cookie: cookie.value }).then((p) => {
        out.hidden = true;
        plan.replaceChildren(...previewView(p, url.value, cookie.value, fail));
      }, fail).finally(() => { compareBtn.disabled = false; });
    });
    return [
      h('p', { class: 'muted' }, 'Link this project to an Overleaf project: co-authors keep writing on Overleaf, you and your agents here, and everyone sees each other\'s edits as they are typed. Text, files and comment threads go both ways.'),
      h('h3', {}, 'Overleaf project address'),
      url,
      h('h3', {}, 'Session cookie'),
      h('p', { class: 'muted' }, COOKIE_HELP),
      cookie,
      h('p', { class: 'muted' }, 'Edits made here reach Overleaf as this account\'s. Comments made here show there as “[Name] text”.'),
      h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), compareBtn),
      out,
      plan,
    ];
  };

  const previewView = (p: LinkPreview, url: string, cookie: string, fail: (err: unknown) => void): Node[] => {
    const choices = new Map<string, 'texwerk' | 'overleaf'>(p.differ.map((d) => [d.path, 'overleaf']));
    const rows = p.differ.map((d) => {
      const name = `ol-${d.path}`;
      const radio = (side: 'texwerk' | 'overleaf', label: string) => {
        const input = h('input', { type: 'radio', name, checked: side === 'overleaf' });
        input.addEventListener('change', () => choices.set(d.path, side));
        return h('label', {}, input, ` ${label}`);
      };
      const diffHost = h('div', { class: 'ol-diff', hidden: true });
      let view: EditorView | null = null;
      const toggle = d.texwerk !== undefined && d.overleaf !== undefined
        ? h('button', { class: 'link', onclick: () => {
          diffHost.hidden = !diffHost.hidden;
          if (!diffHost.hidden && !view) view = showDiff(diffHost, d.overleaf!, d.texwerk!);
          toggle!.textContent = diffHost.hidden ? 'Show differences' : 'Hide differences';
        } }, 'Show differences')
        : null;
      return h('div', { class: 'ol-item' },
        h('div', { class: 'ol-row' },
          h('code', { title: d.path }, d.path),
          h('span', { class: 'muted' }, d.kind === 'binary' ? 'file' : 'text'),
          ...(toggle ? [toggle] : []),
          h('span', { class: 'ol-choice' }, radio('texwerk', 'Keep TeXWerk'), radio('overleaf', 'Take Overleaf'))),
        diffHost);
    });
    const list = (title: string, paths: string[]) => (paths.length
      ? [h('details', {}, h('summary', {}, `${title}: ${paths.length}`), h('div', { class: 'ol-paths' }, ...paths.map((x) => h('code', {}, x))))] : []);
    const linkBtn = h('button', { class: 'primary' }, 'Link');
    linkBtn.addEventListener('click', () => {
      linkBtn.disabled = true;
      void api<{ info: OverleafInfo }>('POST', `/api/overleaf/link${q}`, { url, cookie, choices: Object.fromEntries(choices) }).then((r) => {
        accept(r.info);
        toast('Linked to Overleaf', 'ok');
      }, (err) => { linkBtn.disabled = false; fail(err); });
    });
    return [
      h('h3', {}, `Overleaf: ${p.name || 'project'}${p.account ? ` (as ${p.account})` : ''}`),
      h('p', {}, `${p.same.length} file(s) are the same on both sides. ${p.toTexwerk.length} are only on Overleaf and come here; ${p.toOverleaf.length} are only here and go to Overleaf. Nothing is deleted.`),
      ...list('Only on Overleaf', p.toTexwerk),
      ...list('Only here', p.toOverleaf),
      ...(rows.length ? [
        h('p', {}, `${rows.length} file(s) differ. Pick the side to keep for each; the other side's text stays in its history (TeXWerk History, Overleaf History). In the differences, red lines are Overleaf's and green lines TeXWerk's.`),
        h('div', { class: 'ol-differ' }, ...rows),
      ] : []),
      h('div', { class: 'actions' }, linkBtn),
    ];
  };

  button.addEventListener('click', open);
  chip.addEventListener('click', open);
  refresh();
  return {
    open,
    refresh,
    update: accept,
  };
}
