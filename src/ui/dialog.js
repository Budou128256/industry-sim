/* アプリの中に出す確認・入力の窓。
 *
 * ブラウザ標準の confirm / prompt は使わない（ユーザーの希望 2026-10-06）。
 * 標準の窓はブラウザごとに見た目が違い、ページの外の窓として出て、
 * 「このページでこれ以上ダイアログを表示しない」で出なくなることもあるため。
 *
 * 使い方:
 *   if (await askConfirm({ title, message, ok: '削除', danger: true })) { ... }
 *   const name = await askText({ title, message, value: '' });   // やめたら null
 *   const v = await askChoice({ title, message, options: [{ value, label }], value });   // やめたら undefined
 *
 * 窓が開いている間は .modal-open が body に付く。input.js はこの間キーを拾わない。
 */

let current = null;     // 開いている窓（同時に1つだけ）

/** はい / いいえ を聞く。OK なら true。 */
export function askConfirm({ title = '確認', message = '', ok = 'OK', cancel = 'やめる', danger = false } = {}) {
  return open({ title, message, ok, cancel, danger, input: null });
}

/** 文字を入れてもらう。やめたら null。空のまま OK は押せない。 */
export function askText({ title = '入力', message = '', value = '', placeholder = '', ok = 'OK', cancel = 'やめる' } = {}) {
  return open({ title, message, ok, cancel, danger: false, input: { value, placeholder } });
}

/** 選び肢から1つ選んでもらう。やめたら undefined（選び肢の value に null も使える）。 */
export async function askChoice({ title = '選ぶ', message = '', options = [], value = null, ok = 'OK', cancel = 'やめる' } = {}) {
  const r = await open({ title, message, ok, cancel, danger: false, input: null, choice: { options, value } });
  return r === false ? undefined : r;
}

/** 窓が開いているか。 */
export function dialogOpen() { return !!current; }

function open({ title, message, ok, cancel, danger, input, choice = null }) {
  if (current) current.finish(input ? null : false);      // 前の窓はやめた扱いで閉じる
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal';
    back.innerHTML = `
      <div class="box" role="dialog" aria-modal="true">
        <div class="title"></div>
        <div class="msg"></div>
        ${input ? '<input type="text" class="text">' : ''}
        ${choice ? '<select class="text"></select>' : ''}
        <div class="btns"><button class="no"></button><button class="yes"></button></div>
      </div>`;
    back.querySelector('.title').textContent = title;
    back.querySelector('.msg').textContent = message;      // 文は textContent で入れる（名前に < などが入っても安全）
    const yes = back.querySelector('.yes'), no = back.querySelector('.no');
    yes.textContent = ok; no.textContent = cancel;
    if (danger) yes.classList.add('danger');
    const field = input ? back.querySelector('.text') : null;
    const pick = choice ? back.querySelector('select') : null;
    if (pick) {
      choice.options.forEach((o, i) => {
        const el = document.createElement('option');
        el.value = String(i); el.textContent = o.label;
        if (o.value === choice.value) el.selected = true;
        pick.appendChild(el);
      });
    }
    if (field) {
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
    }
    const valid = () => !field || field.value.trim() !== '';
    const sync = () => { yes.disabled = !valid(); };

    const finish = result => {
      if (current !== state) return;
      current = null;
      back.remove();
      document.body.classList.remove('modal-open');
      window.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(result);
    };
    const accept = () => {
      if (!valid()) return;
      if (pick) finish(choice.options[Number(pick.value)].value);
      else finish(field ? field.value.trim() : true);
    };
    const reject = () => finish(field ? null : false);
    // 窓が開いている間のキーは、ここで止める（盤面の操作に届かないように）
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); reject(); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); accept(); }   // 日本語の変換中の Enter は確定に使う
      e.stopPropagation();
    };

    yes.onclick = accept;
    no.onclick = reject;
    back.addEventListener('mousedown', e => { if (e.target === back) reject(); });   // 窓の外を押したらやめる
    if (field) field.addEventListener('input', sync);
    sync();

    const prevFocus = document.activeElement;
    const state = { finish };
    current = state;
    document.body.appendChild(back);
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', onKey, true);
    (field || pick || (danger ? no : yes)).focus();             // 消す操作は「やめる」に初めから合わせておく
    if (field) field.select();
  });
}
