// 論理回路シミュレータ（図解 CPU）。小さな回路記述言語のパーサと評価器。
// DOM は使わない。ブラウザでは window.LOGIC、Node では import すると globalThis.LOGIC。
//
// ====================================================================== 言語
//
//   # 半加算器                      ← コメントは # か //
//   in a, b                         ← 入力。バスは in a[4]（4 ビット。a[0] が最下位）
//   out s, c                        ← 出力。out s[4] と幅を書いてもよい（書かなければ右辺から決まる）
//   s = a xor b                     ← 「名前 = 式」で線に名前を付ける。out s = a xor b と 1 行でも書ける
//   c = a and b
//
// ・文は 1 行に 1 つ（; で区切れば 1 行に複数書ける）。行末が演算子・, ・( なら次の行へ続く。
// ・行の順番は自由（回路なので、上から順に実行されるわけではない）。あとの行で作る線を先に使ってよい。
// ・名前は英字か _ で始まる英数字。予約語：in out wire reg def test step clock and or not xor nand nor xnor mux
//   （予約語と演算子は大文字でもよい：AND, Not）。
//
// 【式】結びつきの強い順
//   1. 添字      a[0]（1 ビット）、a[3:0]（上位:下位 の範囲）
//   2. not a     記号は ~a、!a
//   3. a + b, a - b     足し算・引き算（部品 1 個と数える。桁あふれは捨てる。幅が違えば 0 で広げる）
//   4. and, nand        記号は &
//   5. xor, xnor        記号は ^
//   6. or, nor          記号は |
//   7. a == b           等しければ 1（1 ビット）
//   同じ強さは左から（a nand b nand c は (a nand b) nand c）。括弧 ( ) で順番を変えられる。
//   関数形：and(a, b, c) or(...) xor(...) nand(...) nor(...) xnor(...) は 2 入力以上（多入力ゲート 1 個と数える）、not(a)。
//   mux(s, a, b)        s が 0 なら a、1 なら b。s が 2 ビットなら mux(s, a, b, c, d)（s の値の番目を選ぶ）。
//   連結 {a, b}         左が上位。{c, s[3:0]} は 5 ビット。
//   数：0, 1, 10 進（幅は相手に合わせる）、0b1010（4 ビット）、0x1f（8 ビット）。
//   バスの演算はビットごと（a and b は幅の数だけ AND ゲートを使う）。片方が 1 ビットなら全ビットに配る
//   （b xor sub で「sub が 1 なら全ビット反転」）。それ以外で幅が違えばエラー。バスは 32 ビットまで。
//
// 【宣言と代入】
//   in a, b[4]          入力
//   out s, c[4]         出力（in 以外の線に付ける印。reg や代入で作った線を出力にできる）
//   wire c[5]           途中の線の幅を先に決める。c[1] = ... のように 1 ビットずつ（c[3:2] = ... と範囲で）入れるときに必要。
//                       out s[4] と宣言した出力にも s[0] = ... と入れられる。
//   x = 式              宣言していない名前は、その場で途中の線になる（幅は右辺から）。
//   s, c = ha(a, b)     部品の複数の出力を受ける。使わない出力は _ で捨てる（s, _ = ha(a, b)）。
//   1 つの線（ビット）に値を入れられるのは 1 回だけ。
//
// 【部品】
//   def ha(a, b) -> (s, c) {        ← 入力と出力。幅は a[4] のように書く（書かなければ 1 ビット）。出力が 1 つなら -> y でもよい
//     s = a xor b
//     c = a and b
//   }
//   def の中から見えるのは、その入力・出力・中で作った線だけ。中で wire、reg、ほかの部品の呼び出しが使える
//   （自分自身は呼べない）。def はファイルのどこに書いてもよい。出力が 1 つの部品は式の中で f(a, b) と使える。
//
// 【組み合わせ回路の結果：真理値表】
//   何も書かなければ全入力の組み合わせ（入力の合計が 10 ビットまで。最初に宣言した入力が上の桁）。
//   test a=3, b=5                   test 行があれば、その組だけを順に評価（書かなかった入力は 0）。
//   test a=1, b=1 -> s=0, c=1       -> の右に期待する出力を書くと、合っているかを調べる（結果の checks）。
//
// 【記憶のある回路の結果：タイミング表と波形】
//   reg q[4] = d                    D フリップフロップ。クロックの立ち上がりで右辺の値を取り込む。初期値 0。
//   reg q = d init 1                初期値を変える。幅を省くと右辺から決まる（決まらなければ 1 ビット）。
//   step a=1, b=0                   入力を変えて（書かなかった入力は前のまま）、回路が落ち着いたところを 1 行記録する。
//   step                            入力を変えずに 1 行。
//   clock 8                         step を 8 回（clock だけなら 1 回）。
//   ・reg があれば、1 行 = クロック 1 周期。行に出るのは「その周期の間の値」で、行の終わりにクロックが立ち上がり、
//     reg は次の行から新しい値になる（step d=1 の行では q はまだ古い値、次の行で 1）。
//   ・帰還のある回路（SR ラッチ：q = r nor nq / nq = s nor q）は、全ゲートが同時に遅延 1 単位で動くとして、
//     値が変わらなくなるまで回す。前の行の状態は次の行に引き継ぐ（保持）。最初はすべての線が 0。
//     落ち着かない（発振する）ときは、その行に unstable の印が付き、揺れている線の値は null（表示は ?）になり、
//     警告が 1 つ出る。エラーにはならず、次の step で値が決まれば元に戻る。
//     例：NOR の SR ラッチは、最初に s=0, r=0 だと決まらない（電源を入れた直後は不定）。s=1, r=1（禁止入力）は
//     q=0, nq=0 で落ち着くが、そこから同時に s=0, r=0 にすると発振する。
//   ・reg や帰還のある回路に step / clock が 1 つもないとエラー（真理値表は作れない）。test と step は混ぜられない。
//
// ====================================================================== API
//
// LOGIC.run(src, opts?) → 結果
//   opts.like          … 別の結果（模範解答の結果）。これと同じ入力の与え方（全通り / test の組 / step の並び）で評価する。
//                        src の中の test / step / clock は無視する。採点で使う。
//   opts.maxInputBits  … 全通りの真理値表を作る入力ビット数の上限（既定 10）
//
//   成功： {
//     ok: true,
//     kind: 'table' | 'timing',
//     inputs:  [{ name, width }],              // 宣言順
//     outputs: [{ name, width }],              // 宣言順
//     wires:   [{ name, width, kind }],        // 最上位で名前を付けた途中の線（kind: 'wire' | 'reg'）
//     rows: [{ in: [..], out: [..], wire: [..], line, unstable?, pass? }],
//                                              // 値は 0 以上の整数（バスも 1 つの数）。null は不定（表示は ?）。
//                                              // in / out / wire は inputs / outputs / wires と同じ並び。
//                                              // line は test / step の行番号（全通りのときは 0）。
//                                              // pass は test 行に -> があるときだけ（true / false）
//     clocked: bool,                           // timing で reg があるとき true（1 行 = 1 周期）
//     wave: [{ name, width, kind, values }],   // timing のとき。kind: 'clock' | 'in' | 'reg' | 'wire' | 'out'。
//                                              // values は行ごとの値（clock は null。1 行につき 1 周期を描く）
//     checks: [{ line, ok, msg }],             // test ... -> ... の結果
//     gates: {
//       total,                                 // ゲートの総数（部品を展開した数。reg は含まない）
//       byKind: { and: 2, xor: 2, ... },       // 種類別（展開した数）。種類：and or not xor nand nor xnor mux add sub eq
//       direct: { or: 1 },                     // 部品の外に直接書いたゲート
//       parts: { ha: { instances: 2, gates: 2 } },   // 部品ごとの、使われた回数と 1 個あたりのゲート数（中の部品も展開）
//       where: { and: [3, 9] },                // その種類のゲートを書いた行
//       ff,                                    // D フリップフロップの数（reg のビット数の合計）
//     },
//     warnings: [{ line, msg }],               // 使っていない入力、値の入っていない出力、発振 など
//     errors: [],
//     stimulus,                                // like に渡すための、入力の与え方
//   }
//   失敗： { ok: false, errors: [{ line, msg }], warnings: [] }   // msg は「4 行目：…」で始まる日本語（line が 0 なら行番号なし）
//
// LOGIC.compare(exp, got) → { ok, reason, msg, ... }
//   2 つの結果（期待と読者）を比べる。比べるのは出力だけ（途中の線とゲート数は見ない）。行は入力の値で突き合わせる。
//   reason: 'same'          一致
//           'error'         got がエラー（msg は最初のエラー文）
//           'kind'          真理値表とタイミング表の違い
//           'inputs'        入力の名前が違う          （missing, extra）
//           'input-width'   入力のビット幅が違う      （name, expected, actual）
//           'outputs'       出力の名前が違う          （missing, extra）
//           'output-width'  出力のビット幅が違う      （name, expected, actual）
//           'rows'          行数が違う
//           'value'         値が違う                  （row（0 始まり）, input: {名前: 値}, name, expected, actual, mismatches: 違う行の数）
//           'unknown'       読者の出力が決まっていない（値が入っていない・発振）。付く情報は value と同じ
//
// LOGIC.limits(result, { only, maxgates }) → { ok, problems: [{ line, msg }], msg }
//   only: 'nand' や 'nand,not' や ['nand', 'not']（使ってよいゲートの種類。reg は対象外）、maxgates: ゲート総数の上限。
//
// LOGIC.grade(answerSrc, userSrc, { only, maxgates }) → { ok, reason, msg, exp, got }
//   模範解答を run、読者の回路を like 付きで run、compare、limits をまとめて行う。
//   reason は compare のものに加えて 'answer-error'（模範解答がエラー）と 'limits'（制限違反）。
//
// LOGIC.fmt(value, width, base?) → 文字列。base: 'dec'（既定）| 'bin' | 'hex'。null は '?'。
// LOGIC.text(result) → 結果を文字の表にしたもの（確認用）。
(function (root) {
  'use strict';

  const GATE_KINDS = ['and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor'];
  const NARY = new Set(['and', 'or', 'xor', 'nand', 'nor', 'xnor']);
  const KEYWORDS = new Set(['in', 'out', 'wire', 'reg', 'def', 'test', 'step', 'clock', 'mux', ...GATE_KINDS]);
  const SYM_OP = { '&': 'and', '|': 'or', '^': 'xor', '~': 'not', '!': 'not' };
  const MAX_WIDTH = 32, MAX_NODES = 50000, MAX_STEPS = 5000, MAX_DEPTH = 40;

  class LogicError extends Error {
    constructor(line, msg) { super(msg); this.line = line || 0; }
  }
  const fail = (line, msg) => { throw new LogicError(line, msg); };
  const q = (s) => '`' + s + '`';
  const errObj = (e) => ({ line: e.line, msg: (e.line ? `${e.line} 行目：` : '') + e.message });

  // ------------------------------------------------------------------ 字句
  function tokenize(src) {
    const toks = [];
    const CONT = new Set(['=', '==', ',', '(', '[', '{', '->', '=>', '&', '|', '^', '~', '!', '+', '-', 'and', 'or', 'xor', 'nand', 'nor', 'xnor', 'not']);
    const re = /\s+|([A-Za-z_][A-Za-z0-9_]*)|(0[bB][01_]+|0[xX][0-9a-fA-F_]+|\d+)(?![A-Za-z0-9_])|(==|->|=>|[()\[\]{},:;=&|~^!+\-])/y;
    String(src).replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
      const line = i + 1;
      let s = raw.replace(/　/g, ' ');
      const c = s.search(/#|\/\//);
      if (c >= 0) s = s.slice(0, c);
      let p = 0;
      while (p < s.length) {
        re.lastIndex = p;
        const m = re.exec(s);
        if (!m) {
          const ch = Array.from(s.slice(p))[0];
          if (/[0-9]/.test(ch)) fail(line, `数の書き方が正しくありません（${q(s.slice(p).match(/^[0-9A-Za-z_]+/)[0])}）。10 進、0b1010、0x1f の形で書いてください`);
          if (ch.codePointAt(0) >= 0xff00 && ch.codePointAt(0) <= 0xffef) fail(line, `全角の文字 ${q(ch)} は使えません。半角で書いてください`);
          if (ch.codePointAt(0) > 0x7f) fail(line, `${q(ch)} は名前に使えません。名前は半角の英数字で書いてください（日本語はコメント # の後ろに書けます）`);
          fail(line, `${q(ch)} という記号は使えません`);
        }
        p = re.lastIndex;
        if (m[1]) {
          const low = m[1].toLowerCase();
          if (KEYWORDS.has(low)) toks.push({ t: 'kw', v: low, line });
          else toks.push({ t: 'id', v: m[1], line });
        } else if (m[2]) {
          const txt = m[2].replace(/_/g, '');
          let value, width = null;
          if (/^0b/i.test(txt)) { width = txt.length - 2; value = parseInt(txt.slice(2), 2); }
          else if (/^0x/i.test(txt)) { width = (txt.length - 2) * 4; value = parseInt(txt.slice(2), 16); }
          else value = parseInt(txt, 10);
          if (width !== null && width > MAX_WIDTH) fail(line, `数 ${q(m[2])} は ${width} ビットあります。${MAX_WIDTH} ビットまでにしてください`);
          if (value > 0xffffffff) fail(line, `数 ${q(m[2])} は大きすぎます（32 ビットまで）`);
          toks.push({ t: 'num', v: value, width, text: m[2], line });
        } else if (m[3]) {
          toks.push({ t: 'sym', v: m[3] === '=>' ? '->' : m[3], line });
        }
      }
      const last = toks[toks.length - 1];
      if (last && last.line === line && (last.t === 'sym' || last.t === 'kw') && CONT.has(last.v)) return; // 次の行へ続く
      toks.push({ t: 'nl', v: '\n', line });
    });
    const lastLine = toks.length ? toks[toks.length - 1].line : 1;
    toks.push({ t: 'eof', v: '', line: lastLine });
    return toks;
  }

  // ------------------------------------------------------------------ 構文
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const is = (t, v) => toks[p].t === t && (v === undefined || toks[p].v === v);
    const isSym = (v) => is('sym', v);
    const show = (tk) => (tk.t === 'nl' || tk.t === 'eof' ? '行の終わり' : q(tk.t === 'num' ? tk.text : tk.v));
    const atEnd = () => is('nl') || is('eof') || isSym(';');
    const lineNow = () => (p > 0 && (toks[p].t === 'nl' || toks[p].t === 'eof') ? toks[p - 1].line : toks[p].line);
    const expectSym = (v, why) => {
      if (isSym(v)) return next();
      fail(lineNow(), why || `${q(v)} が必要ですが、${show(peek())} があります`);
    };
    const name = (what) => {
      const tk = peek();
      if (tk.t === 'id') {
        if (tk.v === '_') fail(tk.line, `${q('_')} だけの名前は使えません（部品の出力を捨てるとき専用です）`);
        return next();
      }
      if (tk.t === 'kw') fail(tk.line, `${q(tk.v)} は予約語なので、${what}には使えません。別の名前にしてください`);
      fail(lineNow(), `${what}が必要ですが、${show(tk)} があります`);
    };
    const width = () => {
      // [N] があれば読む
      if (!isSym('[')) return null;
      next();
      const tk = peek();
      if (tk.t !== 'num') fail(lineNow(), `[ ] の中にはビット数を数で書いてください（例：a[4]）`);
      next();
      if (isSym(':')) fail(tk.line, `宣言の [ ] にはビット数を 1 つだけ書きます（例：a[4] で 4 ビット）`);
      expectSym(']');
      if (tk.v < 1) fail(tk.line, `ビット数は 1 以上にしてください`);
      if (tk.v > MAX_WIDTH) fail(tk.line, `バスは ${MAX_WIDTH} ビットまでです（${tk.v} ビットは作れません）`);
      return tk.v;
    };
    const range = () => {
      // [i] か [hi:lo]
      next();
      const a = peek();
      if (a.t !== 'num') fail(lineNow(), `添字は数で書いてください（例：a[0]、a[3:0]）`);
      next();
      let hi = a.v, lo = a.v;
      if (isSym(':')) {
        next();
        const b = peek();
        if (b.t !== 'num') fail(lineNow(), `範囲は a[3:0] のように「上位:下位」を数で書いてください`);
        next();
        lo = b.v;
        if (lo > hi) fail(a.line, `範囲は「上位:下位」の順に書きます（[${hi}:${lo}] ではなく [${lo}:${hi}]）`);
      }
      expectSym(']');
      return { hi, lo };
    };

    // 式
    const binLevel = (sub, ops) => () => {
      let a = sub();
      for (;;) {
        const tk = peek();
        let op = null;
        if (tk.t === 'kw' && ops.includes(tk.v)) op = tk.v;
        else if (tk.t === 'sym' && SYM_OP[tk.v] && ops.includes(SYM_OP[tk.v]) && tk.v !== '~' && tk.v !== '!') op = SYM_OP[tk.v];
        if (!op) return a;
        next();
        if (atEnd() || isSym(')') || isSym(',') || isSym('}')) fail(tk.line, `${q(tk.v)} の右側に式がありません`);
        const b = sub();
        a = { k: 'gate', op, args: [a, b], line: tk.line };
      }
    };
    const primary = () => {
      const tk = peek();
      if (tk.t === 'num') { next(); return { k: 'num', value: tk.v, width: tk.width, text: tk.text, line: tk.line }; }
      if (tk.t === 'sym' && tk.v === '(') {
        next();
        if (isSym(')')) fail(tk.line, `( ) の中が空です`);
        const e = expr();
        expectSym(')', `${q(')')} が足りません（${q('(')} を閉じてください）`);
        return e;
      }
      if (tk.t === 'sym' && tk.v === '{') {
        next();
        const parts = [expr()];
        while (isSym(',')) { next(); parts.push(expr()); }
        expectSym('}', `連結の ${q('}')} が足りません`);
        return { k: 'cat', parts, line: tk.line };
      }
      const args = () => {
        next();
        const list = [];
        if (!isSym(')')) {
          list.push(expr());
          while (isSym(',')) { next(); list.push(expr()); }
        }
        expectSym(')', `${q(')')} が足りません（${q('(')} を閉じてください）`);
        return list;
      };
      if (tk.t === 'kw' && (NARY.has(tk.v) || tk.v === 'mux')) {
        next();
        if (!isSym('(')) {
          if (tk.v === 'mux') fail(tk.line, `mux は mux(s, a, b) の形で書いてください`);
          fail(tk.line, `${q(tk.v)} の左側に式がありません（a ${tk.v} b か ${tk.v}(a, b) の形で書いてください）`);
        }
        const list = args();
        if (tk.v === 'mux') return { k: 'mux', args: list, line: tk.line };
        if (list.length < 2) fail(tk.line, `${tk.v}( ) には 2 つ以上の入力が必要です`);
        return { k: 'gate', op: tk.v, args: list, line: tk.line };
      }
      if (tk.t === 'id') {
        next();
        if (isSym('(')) return { k: 'call', name: tk.v, args: args(), line: tk.line };
        if (tk.v === '_') fail(tk.line, `${q('_')} は式の中では使えません`);
        return { k: 'name', name: tk.v, line: tk.line };
      }
      if (tk.t === 'kw') fail(tk.line, `${q(tk.v)} はここには書けません（予約語です）`);
      if (tk.t === 'sym' && (tk.v === '&' || tk.v === '|' || tk.v === '^' || tk.v === '+' || tk.v === '==')) fail(tk.line, `${q(tk.v)} の左側に式がありません`);
      if (tk.t === 'sym' && tk.v === ')') fail(tk.line, `${q(')')} が多すぎます（対応する ${q('(')} がありません）`);
      fail(lineNow(), `式が必要ですが、${show(tk)} があります`);
    };
    const postfix = () => {
      let e = primary();
      while (isSym('[')) {
        const line = peek().line;
        const r = range();
        e = { k: 'index', a: e, hi: r.hi, lo: r.lo, line };
      }
      return e;
    };
    const unary = () => {
      const tk = peek();
      if ((tk.t === 'kw' && tk.v === 'not') || (tk.t === 'sym' && (tk.v === '~' || tk.v === '!'))) {
        next();
        if (atEnd()) fail(tk.line, `${q(tk.v)} の右側に式がありません`);
        return { k: 'gate', op: 'not', args: [unary()], line: tk.line };
      }
      return postfix();
    };
    const addLevel = () => {
      let a = unary();
      while (isSym('+') || isSym('-')) {
        const tk = next();
        if (atEnd()) fail(tk.line, `${q(tk.v)} の右側に式がありません`);
        a = { k: 'arith', op: tk.v === '+' ? 'add' : 'sub', a, b: unary(), line: tk.line };
      }
      return a;
    };
    const andLevel = binLevel(addLevel, ['and', 'nand']);
    const xorLevel = binLevel(andLevel, ['xor', 'xnor']);
    const orLevel = binLevel(xorLevel, ['or', 'nor']);
    function expr() {
      const a = orLevel();
      if (isSym('==')) {
        const tk = next();
        if (atEnd()) fail(tk.line, `${q('==')} の右側に式がありません`);
        return { k: 'arith', op: 'eq', a, b: orLevel(), line: tk.line };
      }
      return a;
    }

    const endStmt = () => {
      if (atEnd() || isSym('}')) return;
      const tk = peek();
      if (tk.t === 'sym' && tk.v === ')') fail(tk.line, `${q(')')} が多すぎます（対応する ${q('(')} がありません）`);
      if (tk.t === 'sym' && tk.v === '=') fail(tk.line, `1 つの行に ${q('=')} が 2 つあります。行を分けてください（等しいかどうかは ${q('==')}）`);
      fail(tk.line, `${show(tk)} の前に、演算子（and や or）か ${q(',')} が抜けていませんか`);
    };
    const declItem = (what) => {
      const tk = name(what);
      return { name: tk.v, width: width(), line: tk.line };
    };
    const assigns = (kw) => {
      // a=1, b=0 の並び（, は省いてもよい）
      const list = [];
      while (is('id') || is('kw')) {
        const tk = name(`${kw} の入力名`);
        expectSym('=', `${kw} は ${q(kw + ' a=1, b=0')} のように「名前=値」で書いてください`);
        const v = peek();
        if (v.t !== 'num') fail(lineNow(), `${q(tk.v + '=')} の右には数を書いてください（例：${tk.v}=1）`);
        next();
        list.push({ name: tk.v, value: v.v, line: tk.line });
        if (isSym(',')) next();
      }
      return list;
    };
    const target = () => {
      const tk = peek();
      if (tk.t === 'id' && tk.v === '_') { next(); return { discard: true, line: tk.line }; }
      const n = name('線の名前');
      const t = { name: n.v, line: n.line };
      if (isSym('[')) { const r = range(); t.hi = r.hi; t.lo = r.lo; }
      return t;
    };

    function statement(inDef) {
      const tk = peek();
      if (tk.t === 'kw' && (tk.v === 'in' || tk.v === 'out' || tk.v === 'wire')) {
        next();
        if (inDef && tk.v !== 'wire') fail(tk.line, `def の中に ${tk.v} は書けません。部品の入力と出力は def ${inDef}(入力) -> (出力) の行に書きます`);
        if (atEnd()) fail(tk.line, `${tk.v} の後ろに名前がありません（例：${tk.v} a, b）`);
        const items = [declItem(`${tk.v} の名前`)];
        if (tk.v !== 'in' && isSym('=')) {
          // out s = a xor b（宣言と代入を 1 行で）
          next();
          const e = expr();
          endStmt();
          return [{ s: 'decl', kind: tk.v, items, line: tk.line }, { s: 'assign', targets: [{ name: items[0].name, line: tk.line }], expr: e, line: tk.line }];
        }
        while (!atEnd()) {
          if (isSym(',')) next();
          else if (is('id')) fail(peek().line, `名前の間は ${q(',')} で区切ってください（${tk.v} ${items[items.length - 1].name}, ${peek().v}）`);
          else if (isSym('=')) fail(peek().line, tk.v === 'in' ? `入力には式を入れられません。${q('in ' + items[0].name)} とだけ書いてください` : `${tk.v} で名前を複数並べたときは、${q('=')} で値を入れられません。行を分けてください`);
          else endStmt();
          items.push(declItem(`${tk.v} の名前`));
        }
        return [{ s: 'decl', kind: tk.v, items, line: tk.line }];
      }
      if (tk.t === 'kw' && tk.v === 'reg') {
        next();
        const it = declItem('reg の名前');
        if (!isSym('=')) fail(tk.line, `reg は ${q('reg ' + it.name + ' = 次に取り込む値')} の形で書いてください`);
        next();
        const e = expr();
        let init = 0;
        if (is('id', 'init')) {
          next();
          const v = peek();
          if (v.t !== 'num') fail(lineNow(), `init の後ろには初期値を数で書いてください（例：init 1）`);
          next();
          init = v.v;
        }
        endStmt();
        return [{ s: 'reg', name: it.name, width: it.width, expr: e, init, line: tk.line }];
      }
      if (tk.t === 'kw' && tk.v === 'def') {
        if (inDef) fail(tk.line, `def の中に def は書けません。${q('}')} で閉じてから、次の def を書いてください`);
        return [parseDef()];
      }
      if (tk.t === 'kw' && (tk.v === 'test' || tk.v === 'step' || tk.v === 'clock')) {
        next();
        if (inDef) fail(tk.line, `def の中に ${tk.v} は書けません（部品の外に書いてください）`);
        if (tk.v === 'clock') {
          let n = 1;
          if (is('num')) n = next().v;
          endStmt();
          if (n < 1) fail(tk.line, `clock の回数は 1 以上にしてください`);
          return [{ s: 'clock', n, line: tk.line }];
        }
        const set = assigns(tk.v);
        let expect = null;
        if (isSym('->')) {
          const ar = next();
          if (tk.v === 'step') fail(ar.line, `${q('->')} で期待する出力を書けるのは test だけです`);
          expect = assigns('test');
          if (!expect.length) fail(ar.line, `${q('->')} の右に、期待する出力を ${q('s=1')} のように書いてください`);
        }
        endStmt();
        if (tk.v === 'test' && !set.length && !expect) fail(tk.line, `test の後ろに入力の値がありません（例：test a=1, b=0）`);
        return [{ s: tk.v, set, expect, line: tk.line }];
      }
      if (tk.t === 'id') {
        const targets = [target()];
        while (isSym(',')) { next(); targets.push(target()); }
        if (!isSym('=')) {
          const nx = peek();
          if (isSym('(')) fail(tk.line, `部品の結果は、名前を付けて受けてください（例：${q('s, c = ' + tk.v + '(a, b)')}）`);
          if (nx.t === 'kw' || nx.t === 'id' || nx.t === 'sym') fail(tk.line, `式だけの行は書けません。${q('名前 = 式')} の形で、線に名前を付けてください`);
          fail(tk.line, `${q(tk.v)} だけでは何をする行か分かりません。${q(tk.v + ' = 式')} の形で書いてください`);
        }
        const eq = next();
        if (atEnd()) fail(eq.line, `${q('=')} の右側に式がありません`);
        const e = expr();
        endStmt();
        return [{ s: 'assign', targets, expr: e, line: tk.line }];
      }
      if (tk.t === 'sym' && tk.v === '}') fail(tk.line, `${q('}')} に対応する ${q('def ... {')} がありません`);
      fail(tk.line, `${show(tk)} で始まる行は書けません。${q('名前 = 式')}、in、out、def などで始めてください`);
    }

    function parseDef() {
      const d = next();
      const nm = name('部品の名前');
      expectSym('(', `def は ${q('def ' + nm.v + '(a, b) -> (y) { ... }')} の形で書いてください`);
      const params = [];
      while (!isSym(')')) {
        params.push(declItem('部品の入力名'));
        if (isSym(',')) next();
        else if (!isSym(')')) fail(lineNow(), `部品の入力は ${q(',')} で区切り、${q(')')} で閉じてください`);
      }
      next();
      if (!isSym('->')) fail(d.line, `def には出力が必要です。${q('def ' + nm.v + '(...) -> (y) {')} のように ${q('->')} の後ろに出力名を書いてください`);
      next();
      const outs = [];
      if (isSym('(')) {
        next();
        while (!isSym(')')) {
          outs.push(declItem('部品の出力名'));
          if (isSym(',')) next();
          else if (!isSym(')')) fail(lineNow(), `部品の出力は ${q(',')} で区切り、${q(')')} で閉じてください`);
        }
        next();
      } else outs.push(declItem('部品の出力名'));
      if (!outs.length) fail(d.line, `部品 ${q(nm.v)} の出力が 1 つもありません`);
      expectSym('{', `def の中身は ${q('{')} と ${q('}')} で囲んでください`);
      const body = [];
      for (;;) {
        while (is('nl') || isSym(';')) next();
        if (is('eof')) fail(d.line, `部品 ${q(nm.v)} を閉じる ${q('}')} がありません`);
        if (isSym('}')) { next(); break; }
        body.push(...statement(nm.v));
      }
      endStmt();
      const seen = new Set();
      [...params, ...outs].forEach((it) => {
        if (seen.has(it.name)) fail(it.line, `部品 ${q(nm.v)} の入力・出力に、同じ名前 ${q(it.name)} が 2 回あります`);
        seen.add(it.name);
        if (it.width === null) it.width = 1;
      });
      return { s: 'def', name: nm.v, params, outs, body, line: d.line };
    }

    const stmts = [];
    for (;;) {
      while (is('nl') || isSym(';')) next();
      if (is('eof')) break;
      stmts.push(...statement(null));
    }
    return stmts;
  }

  // ------------------------------------------------------------------ 似た名前の提案
  function near(nameStr, candidates) {
    const dist = (a, b) => {
      const m = a.length, n = b.length;
      let prev = Array.from({ length: n + 1 }, (_, j) => j);
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
      return prev[n];
    };
    let best = null, bd = 99;
    for (const c of candidates) {
      if (c === nameStr) continue;
      const d = c.toLowerCase() === nameStr.toLowerCase() ? 0.5 : dist(c, nameStr);
      if (d < bd) { bd = d; best = c; }
    }
    return best && (bd < 1 || (nameStr.length >= 3 && bd <= Math.floor(nameStr.length / 3))) ? `（${q(best)} の書き間違いではありませんか）` : '';
  }

  // ------------------------------------------------------------------ 回路に展開
  function elaborate(stmts) {
    const C = {
      parent: [0, 1], // 線（1 ビット）の番号。0 と 1 は定数
      nodes: [], regs: [], uses: [], warnings: [], warned: new Set(),
      defs: new Map(), stack: [], parts: {},
    };
    const newNet = () => { C.parent.push(C.parent.length); return C.parent.length - 1; };
    const find = (x) => {
      while (C.parent[x] !== x) { C.parent[x] = C.parent[C.parent[x]]; x = C.parent[x]; }
      return x;
    };
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a === b) return;
      if (a < 2) C.parent[b] = a; else C.parent[a] = b;
    };
    const warn = (line, msg) => {
      const key = line + msg;
      if (C.warned.has(key)) return;
      C.warned.add(key);
      C.warnings.push({ line, msg: (line ? `${line} 行目：` : '') + msg });
    };
    const inPart = () => (C.stack.length ? `部品 ${q(C.stack[C.stack.length - 1])} の中の ` : '');

    for (const st of stmts) {
      if (st.s !== 'def') continue;
      if (C.defs.has(st.name)) fail(st.line, `部品 ${q(st.name)} は ${C.defs.get(st.name).line} 行目ですでに作っています`);
      C.defs.set(st.name, st);
    }

    const node = (kind, ins, nOut, line, extra) => {
      if (C.nodes.length >= MAX_NODES) fail(line, `回路が大きすぎます（ゲートが ${MAX_NODES} 個を超えました）`);
      const outs = Array.from({ length: nOut }, newNet);
      C.nodes.push({ kind, ins, outs, line, path: C.stack.slice(), ...extra });
      return outs;
    };
    const bitlen = (v) => Math.max(1, Math.floor(Math.log2(Math.max(v, 1))) + 1);
    const constNets = (v, w) => Array.from({ length: w }, (_, i) => Math.floor(v / 2 ** i) % 2);
    // 値を w ビットの線の並びにする（w が null なら、数は最小の幅）
    const toNets = (v, w, line, what) => {
      if (v.c !== undefined) {
        const ww = w === null ? bitlen(v.c) : w;
        if (v.c >= 2 ** ww) fail(line, `数 ${v.c} は ${ww} ビットに入りません（${ww} ビットで表せるのは 0〜${2 ** ww - 1}）`);
        return constNets(v.c, ww);
      }
      if (w !== null && v.n.length !== w) fail(line, what ? what(v.n.length) : `ビット幅が合いません（${w} ビットのところに ${v.n.length} ビット）`);
      return v.n;
    };

    function elabScope(body, scope) {
      const sigs = scope.sigs;
      const top = scope.top;
      const getOrMake = (nm, line) => {
        let s = sigs.get(nm);
        if (!s) { s = { name: nm, kind: 'wire', implicit: true, isOut: false, width: null, nets: null, line, src: null, parts: false, used: false }; sigs.set(nm, s); }
        return s;
      };
      // --- A: 宣言を集める
      for (const st of body) {
        if (st.s === 'decl') {
          for (const it of st.items) {
            const ex = sigs.get(it.name);
            if (st.kind === 'in') {
              if (ex) fail(it.line, `${q(it.name)} は ${ex.line} 行目ですでに使っている名前です`);
              sigs.set(it.name, { name: it.name, kind: 'in', isOut: false, width: it.width || 1, nets: null, line: it.line, used: false });
            } else if (st.kind === 'out') {
              if (ex && ex.kind === 'in') fail(it.line, `${q(it.name)} は in で宣言した入力なので、out にはできません。出力には別の名前を付けてください（例：${q('y = ' + it.name)}）`);
              if (ex && ex.isOut) fail(it.line, `${q(it.name)} は ${ex.outLine} 行目ですでに out で宣言しています`);
              const s = getOrMake(it.name, it.line);
              s.isOut = true; s.outLine = it.line;
              if (it.width !== null) {
                if (s.width !== null && s.declared && s.width !== it.width) fail(it.line, `${q(it.name)} のビット幅が、${s.line} 行目の宣言（${s.width} ビット）と違います`);
                s.width = it.width; s.declared = true;
              }
            } else {
              if (ex && (ex.kind !== 'wire' || ex.declared && !ex.isOut || ex.kind === 'reg')) fail(it.line, `${q(it.name)} は ${ex.line} 行目ですでに宣言しています`);
              if (ex && (ex.kind === 'param' || ex.kind === 'ret')) fail(it.line, `${q(it.name)} は部品の入力・出力としてすでに宣言されています`);
              const s = getOrMake(it.name, it.line);
              s.implicit = false;
              if (it.width !== null) {
                if (s.declared && s.width !== it.width) fail(it.line, `${q(it.name)} のビット幅が、${s.line} 行目の宣言（${s.width} ビット）と違います`);
                s.width = it.width; s.declared = true;
              }
            }
          }
        } else if (st.s === 'reg') {
          const ex = sigs.get(st.name);
          if (ex && (ex.kind !== 'wire' || ex.src || ex.parts)) {
            if (ex.kind === 'in' || ex.kind === 'param') fail(st.line, `${q(st.name)} は入力なので、reg にはできません`);
            if (ex.kind === 'ret') { /* 部品の出力を reg にするのはよい */ }
            else fail(st.line, `${q(st.name)} には ${ex.line} 行目ですでに値を入れています`);
          }
          if (ex && ex.kind === 'ret' && (ex.src || ex.isReg)) fail(st.line, `${q(st.name)} にはすでに値を入れています`);
          const s = getOrMake(st.name, st.line);
          s.isReg = true; s.implicit = false;
          if (s.kind === 'wire') s.kind = 'reg';
          if (st.width !== null) {
            if (s.declared && s.width !== st.width) fail(st.line, `${q(st.name)} のビット幅が、ほかの宣言（${s.width} ビット）と違います`);
            s.width = st.width; s.declared = true;
          }
          s.src = { expr: st.expr };
        } else if (st.s === 'assign') {
          st.targets.forEach((t, i) => {
            if (t.discard) return;
            const s = getOrMake(t.name, t.line);
            if (t.hi !== undefined) { s.parts = true; return; }
            if (!s.src) s.src = st.targets.length === 1 ? { expr: st.expr } : { call: st.expr, idx: i };
          });
        } else if (st.s === 'def' && !top) fail(st.line, 'def の中に def は書けません');
      }
      // --- B: 幅を決める
      const widthOf = (e) => {
        switch (e.k) {
          case 'name': { const s = sigs.get(e.name); return s ? infer(s) : null; }
          case 'num': return e.width;
          case 'gate': { let w = null; for (const a of e.args) { const x = widthOf(a); if (x !== null && (w === null || x > w)) w = x; } return w; }
          case 'mux': { let w = null; for (const a of e.args.slice(1)) { const x = widthOf(a); if (x !== null && (w === null || x > w)) w = x; } return w; }
          case 'arith': { if (e.op === 'eq') return 1; const a = widthOf(e.a), b = widthOf(e.b); return a === null ? b : b === null ? a : Math.max(a, b); }
          case 'index': return e.hi - e.lo + 1;
          case 'cat': return e.parts.reduce((acc, x) => acc + (widthOf(x) || 1), 0);
          case 'call': { const d = C.defs.get(e.name); return d && d.outs.length === 1 ? d.outs[0].width : null; }
        }
        return null;
      };
      function infer(s) {
        if (s.width !== null) return s.width;
        if (s.inferring || !s.src) return null;
        s.inferring = true;
        let w = null;
        if (s.src.expr) w = widthOf(s.src.expr);
        else { const d = s.src.call.k === 'call' ? C.defs.get(s.src.call.name) : null; if (d && d.outs[s.src.idx]) w = d.outs[s.src.idx].width; }
        s.inferring = false;
        if (w !== null) s.width = w;
        return w;
      }
      for (const s of sigs.values()) {
        if (s.width !== null) continue;
        const w = infer(s);
        if (w === null && !s.src && s.parts) fail(s.line, `${q(s.name)} に 1 ビットずつ値を入れるには、先に ${q('wire ' + s.name + '[ビット数]')} で幅を宣言してください`);
        if (s.width === null) s.width = w === null ? 1 : w;
      }
      // --- C: 線を作る
      for (const s of sigs.values()) {
        if (!s.nets) s.nets = Array.from({ length: s.width }, newNet);
        if (!s.driven) s.driven = new Array(s.width).fill(0);
      }

      // --- D: 式を評価してゲートを作る
      const lookup = (nm, line) => {
        const s = sigs.get(nm);
        if (s) return s;
        if (!top && scope.topSigs && scope.topSigs.has(nm)) fail(line, `${inPart()}${q(nm)} は部品の外の線です。部品の中から外の線は見えません。def ${scope.def}(...) の入力に加えて渡してください`);
        if (C.defs.has(nm)) fail(line, `${q(nm)} は部品の名前です。${q(nm + '(...)')} の形で呼び出してください`);
        fail(line, `${inPart()}${q(nm)} はまだ値が決まっていません。${q(nm + ' = ...')} の行を書くか、${top ? 'in で宣言' : '部品の入力に追加'}してください${near(nm, sigs.keys())}`);
      };
      const evalName = (e, hi, lo) => {
        const s = lookup(e.name, e.line);
        s.used = true;
        let nets = s.nets;
        if (hi !== undefined) {
          if (hi >= s.width) fail(e.line, s.width === 1 ? `${q(e.name)} は 1 ビットの線なので、添字は付けられません（${q(e.name + '[' + hi + ']')}）` : `${q(e.name + '[' + hi + ']')} はありません。${q(e.name)} は ${s.width} ビットなので、添字は 0〜${s.width - 1} です`);
          nets = nets.slice(lo, hi + 1);
        }
        C.uses.push({ name: e.name, line: e.line, nets, part: scope.def, sig: s });
        return { n: nets };
      };
      const gateBits = (kind, args, line) => {
        // args: 値の並び。幅をそろえて、ビットごとにゲートを作る
        let W = null;
        for (const a of args) if (a.c === undefined && (W === null || a.n.length > W)) W = a.n.length;
        if (W === null) W = Math.max(...args.map((a) => bitlen(a.c)));
        const cols = args.map((a, i) => {
          const n = toNets(a, a.c !== undefined ? W : null, line);
          if (n.length === W) return n;
          if (n.length === 1) return new Array(W).fill(n[0]);
          const widths = args.map((x) => (x.c !== undefined ? null : x.n.length)).filter((x) => x !== null);
          fail(line, `${q(kind)} の両側のビット幅が合いません（${widths.join(' ビットと ')} ビット）。同じ幅にするか、片方を 1 ビットにしてください`);
        });
        const out = [];
        for (let i = 0; i < W; i++) out.push(node(kind, cols.map((c) => c[i]), 1, line)[0]);
        return out;
      };
      const ev = (e, want) => {
        switch (e.k) {
          case 'name': return evalName(e);
          case 'num':
            if (e.width !== null) return { n: constNets(e.value, e.width) };
            return { c: e.value };
          case 'index': {
            if (e.a.k === 'name') return evalName(e.a, e.hi, e.lo);
            const v = ev(e.a, null);
            if (v.c !== undefined) fail(e.line, `数には添字を付けられません`);
            if (e.hi >= v.n.length) fail(e.line, `添字 [${e.hi}] が範囲の外です（この値は ${v.n.length} ビットなので 0〜${v.n.length - 1}）`);
            return { n: v.n.slice(e.lo, e.hi + 1) };
          }
          case 'cat': {
            const out = [];
            for (let i = e.parts.length - 1; i >= 0; i--) {
              const v = ev(e.parts[i], null);
              if (v.c !== undefined && v.c > 1) fail(e.line, `連結 { } の中の数 ${v.c} はビット数が分かりません。0 か 1、または 0b101 のように書いてください`);
              out.push(...toNets(v, v.c !== undefined ? 1 : null, e.line));
            }
            if (out.length > MAX_WIDTH) fail(e.line, `連結した結果が ${out.length} ビットあります。バスは ${MAX_WIDTH} ビットまでです`);
            return { n: out };
          }
          case 'gate': {
            const args = e.args.map((a) => ev(a, want));
            return { n: gateBits(e.op, args, e.line) };
          }
          case 'mux': {
            if (e.args.length < 3) fail(e.line, `mux は mux(s, a, b) のように、選ぶ信号と、選ばれる値を 2 つ以上書いてください`);
            const sel = ev(e.args[0], null);
            if (sel.c !== undefined) fail(e.line, `mux の 1 つ目（選ぶ信号）には、数ではなく線を書いてください`);
            const k = sel.n.length;
            if (e.args.length - 1 !== 2 ** k) fail(e.line, `mux の選ぶ信号が ${k} ビットなので、選ばれる値は ${2 ** k} 個必要です（いま ${e.args.length - 1} 個）`);
            const vals = e.args.slice(1).map((a) => ev(a, want));
            let W = null;
            for (const a of vals) if (a.c === undefined && (W === null || a.n.length > W)) W = a.n.length;
            if (W === null) W = Math.max(...vals.map((a) => bitlen(a.c)));
            const cols = vals.map((a) => {
              const n = toNets(a, a.c !== undefined ? W : null, e.line);
              if (n.length === W) return n;
              if (n.length === 1) return new Array(W).fill(n[0]);
              fail(e.line, `mux で選ばれる値のビット幅がそろっていません（${W} ビットと ${n.length} ビット）`);
            });
            const out = [];
            for (let i = 0; i < W; i++) out.push(node('mux', [...sel.n, ...cols.map((c) => c[i])], 1, e.line, { k })[0]);
            return { n: out };
          }
          case 'arith': {
            const a = ev(e.a, want), b = ev(e.b, want);
            let W = Math.max(a.c !== undefined ? 0 : a.n.length, b.c !== undefined ? 0 : b.n.length);
            if (!W) W = Math.max(bitlen(a.c), bitlen(b.c), e.op === 'eq' ? 1 : want || 1);
            const ext = (v) => {
              const n = toNets(v, v.c !== undefined ? W : null, e.line);
              return n.length < W ? [...n, ...new Array(W - n.length).fill(0)] : n;
            };
            return { n: node(e.op, [...ext(a), ...ext(b)], e.op === 'eq' ? 1 : W, e.line, { w: W }) };
          }
          case 'call': {
            if (!C.defs.has(e.name)) fail(e.line, `${q(e.name)} という部品はありません。${q('def ' + e.name + '(...) -> (...) { ... }')} で作れます${near(e.name, [...C.defs.keys(), ...GATE_KINDS, 'mux'])}`);
            const res = callDef(e);
            if (res.length !== 1) fail(e.line, `部品 ${q(e.name)} は ${res.length} つの値を返すので、式の中では使えません。${q(C.defs.get(e.name).outs.map((o) => o.name).join(', ') + ' = ' + e.name + '(...)')} のように受けてください`);
            return { n: res[0] };
          }
        }
        fail(e.line, '式が正しくありません');
      };
      function callDef(e) {
        const d = C.defs.get(e.name);
        if (C.stack.includes(e.name)) fail(e.line, `部品 ${q(e.name)} が、自分自身を（直接か、ほかの部品を通して）呼んでいます。回路は無限に大きくできません`);
        if (C.stack.length >= MAX_DEPTH) fail(e.line, `部品の入れ子が深すぎます`);
        if (e.args.length !== d.params.length) fail(e.line, `部品 ${q(e.name)} の入力は ${d.params.length} 個ですが、${e.args.length} 個渡しています（${e.name}(${d.params.map((x) => x.name).join(', ')})）`);
        const inner = new Map();
        d.params.forEach((pm, i) => {
          const v = ev(e.args[i], pm.width);
          const nets = toNets(v, pm.width, e.line, (got) => `部品 ${q(e.name)} の ${i + 1} 番目の入力 ${q(pm.name)} は ${pm.width} ビットですが、渡した値は ${got} ビットです`);
          inner.set(pm.name, { name: pm.name, kind: 'param', isOut: false, width: pm.width, nets, driven: new Array(pm.width).fill(-1), line: pm.line, used: false });
        });
        d.outs.forEach((o) => inner.set(o.name, { name: o.name, kind: 'ret', isOut: false, declared: true, width: o.width, nets: null, line: o.line, src: null, parts: false, used: true }));
        const before = C.nodes.length, regsBefore = C.regs.length;
        C.stack.push(e.name);
        const callLine = e.line;
        elabScope(d.body, { sigs: inner, top: false, def: e.name, topSigs: scope.topSigs || (top ? sigs : null), callLine });
        for (const o of d.outs) {
          const s = inner.get(o.name);
          const miss = s.driven.findIndex((x) => !x);
          if (miss >= 0) fail(d.line, `部品 ${q(e.name)} の出力 ${q(o.name)}${s.width > 1 ? ` の ${miss} ビット目` : ''} に値を入れる行がありません。def の中に ${q(o.name + (s.width > 1 && s.driven.some((x) => x) ? '[' + miss + ']' : '') + ' = ...')} を書いてください`);
        }
        C.stack.pop();
        const info = C.parts[e.name] || (C.parts[e.name] = { instances: 0, gates: C.nodes.length - before, ff: C.regs.length - regsBefore });
        info.instances++;
        return d.outs.map((o) => inner.get(o.name).nets);
      }
      const connect = (t, v, line) => {
        if (t.discard) return;
        const s = sigs.get(t.name);
        if (s.kind === 'in') fail(line, `${q(t.name)} は入力（in）なので、値を入れられません。別の名前の線に入れてください`);
        if (s.kind === 'param') fail(line, `${q(t.name)} は部品 ${q(scope.def)} の入力なので、値を入れられません`);
        let lo = 0, hi = s.width - 1;
        if (t.hi !== undefined) {
          if (t.hi >= s.width) fail(line, `${q(t.name + '[' + t.hi + ']')} はありません。${q(t.name)} は ${s.width} ビットなので、添字は 0〜${s.width - 1} です`);
          lo = t.lo; hi = t.hi;
        }
        const w = hi - lo + 1;
        const tn = t.name + (t.hi === undefined ? '' : t.hi === t.lo ? `[${t.hi}]` : `[${t.hi}:${t.lo}]`);
        const nets = toNets(v, w, line, (got) => `ビット幅が合いません。${q(tn)} は ${w} ビットですが、右辺は ${got} ビットです`);
        for (let i = 0; i < w; i++) {
          const prev = s.driven[lo + i];
          if (prev) fail(line, s.isReg ? `${q(t.name)} は reg なので、${q(t.name + ' = ...')} で値を入れられません（次に取り込む値は reg の行に書きます）` : prev === line ? `${q(t.name)} に同じ行で 2 回値を入れています` : `${q(t.name)}${s.width > 1 && t.hi !== undefined ? ` の ${lo + i} ビット目` : ''} には ${prev} 行目ですでに値を入れています。1 つの線に入れられる値は 1 つだけです`);
          s.driven[lo + i] = line;
          union(s.nets[lo + i], nets[i]);
        }
      };

      for (const st of body) {
        if (st.s === 'assign') {
          const isCall = st.expr.k === 'call' && C.defs.has(st.expr.name);
          if (isCall) {
            const res = callDef(st.expr);
            if (res.length !== st.targets.length) fail(st.line, `部品 ${q(st.expr.name)} は ${res.length} つの値を返しますが、左辺の名前は ${st.targets.length} つです（${C.defs.get(st.expr.name).outs.map((o) => o.name).join(', ')} の順に受けます）`);
            res.forEach((nets, i) => connect(st.targets[i], { n: nets }, st.line));
          } else {
            if (st.targets.length !== 1) fail(st.line, `左辺に名前が ${st.targets.length} つありますが、右辺の値は 1 つです。複数の値を返せるのは部品（def）の呼び出しだけです`);
            const t = st.targets[0];
            if (t.discard) fail(st.line, `${q('_')} は部品の出力を捨てるときだけ使えます`);
            const s = sigs.get(t.name);
            const want = t.hi !== undefined ? t.hi - t.lo + 1 : s.width;
            connect(t, ev(st.expr, want), st.line);
          }
        } else if (st.s === 'reg') {
          const s = sigs.get(st.name);
          const d = toNets(ev(st.expr, s.width), s.width, st.line, (got) => `ビット幅が合いません。reg ${q(st.name)} は ${s.width} ビットですが、右辺は ${got} ビットです`);
          if (st.init >= 2 ** s.width) fail(st.line, `初期値 ${st.init} は ${s.width} ビットに入りません`);
          for (let i = 0; i < s.width; i++) {
            if (s.driven[i]) fail(st.line, `${q(st.name)} には ${s.driven[i]} 行目ですでに値を入れています`);
            s.driven[i] = st.line;
            C.regs.push({ q: s.nets[i], d: d[i], init: Math.floor(st.init / 2 ** i) % 2, line: st.line });
          }
        }
      }
      // 使っていない線
      for (const s of sigs.values()) {
        if (s.used || s.isOut || s.kind === 'ret') continue;
        if (s.kind === 'in') warn(s.line, `入力 ${q(s.name)} はどこにも使われていません`);
        else if (s.kind === 'param') warn(s.line, `部品 ${q(scope.def)} の入力 ${q(s.name)} は、部品の中で使われていません`);
        else if (!top || scope.hasOut) warn(s.line, `${top ? '' : `部品 ${q(scope.def)} の中の `}${q(s.name)} はどこにも使われていません`);
      }
    }

    const topSigs = new Map();
    const topBody = stmts.filter((s) => s.s !== 'def' && s.s !== 'test' && s.s !== 'step' && s.s !== 'clock');
    const hasOut = topBody.some((s) => s.s === 'decl' && s.kind === 'out');
    elabScope(topBody, { sigs: topSigs, top: true, def: null, hasOut });

    // 値の決まっていない線を使っていないか
    const driven = new Set([0, 1]);
    for (const s of topSigs.values()) if (s.kind === 'in') s.nets.forEach((n) => driven.add(find(n)));
    for (const nd of C.nodes) nd.outs.forEach((n) => driven.add(find(n)));
    for (const r of C.regs) driven.add(find(r.q));
    let bad = null;
    for (const u of C.uses) {
      if (u.nets.every((n) => driven.has(find(n)))) continue;
      if (!bad || u.line < bad.line) bad = u;
    }
    if (bad) {
      const where = bad.part ? `部品 ${q(bad.part)} の中の ` : '';
      const s = bad.sig;
      if (s.driven.some((x) => x > 0) && s.width > 1) {
        const miss = s.driven.findIndex((x) => !x);
        if (miss >= 0) fail(bad.line, `${where}${q(bad.name)} の ${miss} ビット目に、まだ値が入っていません。${q(bad.name + '[' + miss + '] = ...')} の行を書いてください`);
      }
      fail(bad.line, `${where}${q(bad.name)} はまだ値が決まっていません。${q(bad.name + ' = ...')} の行を書くか、${bad.part ? '部品の入力に追加' : 'in で宣言'}してください`);
    }

    // 最終的な形（線の番号を代表にそろえる）
    const R = (n) => find(n);
    const inputs = [], outputs = [], wires = [];
    for (const s of topSigs.values()) {
      const item = { name: s.name, width: s.width, nets: s.nets.map(R) };
      if (s.kind === 'in') inputs.push(item);
      else if (s.isOut) {
        item.known = item.nets.every((n) => driven.has(n));
        item.isReg = !!s.isReg;
        if (!item.known) {
          const miss = s.driven.findIndex((x) => !x);
          warn(s.outLine, s.driven.some((x) => x) ? `出力 ${q(s.name)} の ${miss} ビット目に値が入っていません（${q(s.name + '[' + miss + '] = ...')} を書いてください）` : `出力 ${q(s.name)} に値を入れる行がありません（${q(s.name + ' = ...')} を書いてください）`);
        }
        outputs.push(item);
      } else if (item.nets.every((n) => driven.has(n))) {
        item.kind = s.isReg ? 'reg' : 'wire';
        wires.push(item);
      }
    }
    if (!outputs.length) warn(0, `out がありません。結果として見たい線を ${q('out 名前')} で宣言してください`);
    const nodes = C.nodes.map((nd) => ({ ...nd, ins: nd.ins.map(R), outs: nd.outs.map(R) }));
    const regs = C.regs.map((r) => ({ ...r, q: R(r.q), d: R(r.d) }));

    // 計算の順番（帰還があれば cyclic）
    const producer = new Map();
    nodes.forEach((nd, i) => nd.outs.forEach((o) => producer.set(o, i)));
    const indeg = new Array(nodes.length).fill(0), fan = nodes.map(() => []);
    nodes.forEach((nd, i) => {
      const seen = new Set();
      for (const n of nd.ins) {
        const pi = producer.get(n);
        if (pi === undefined || seen.has(pi)) continue;
        seen.add(pi); indeg[i]++; fan[pi].push(i);
      }
    });
    const order = [];
    const queue = [];
    indeg.forEach((d, i) => { if (!d) queue.push(i); });
    while (queue.length) {
      const i = queue.shift();
      order.push(nodes[i]);
      for (const j of fan[i]) if (!--indeg[j]) queue.push(j);
    }
    const cyclic = order.length < nodes.length;

    // ゲートの集計
    const gates = { total: nodes.length, byKind: {}, direct: {}, parts: {}, where: {}, ff: regs.length };
    for (const nd of nodes) {
      gates.byKind[nd.kind] = (gates.byKind[nd.kind] || 0) + 1;
      if (!nd.path.length) gates.direct[nd.kind] = (gates.direct[nd.kind] || 0) + 1;
      (gates.where[nd.kind] || (gates.where[nd.kind] = new Set())).add(nd.line);
    }
    for (const k of Object.keys(gates.where)) gates.where[k] = [...gates.where[k]].sort((a, b) => a - b);
    for (const [k, v] of Object.entries(C.parts)) gates.parts[k] = { instances: v.instances, gates: v.gates };

    return { size: C.parent.length, inputs, outputs, wires, nodes, regs, order, cyclic, gates, warnings: C.warnings };
  }

  // ------------------------------------------------------------------ 評価
  function evalNode(nd, src, dst) {
    const ins = nd.ins;
    let v = 0;
    switch (nd.kind) {
      case 'and': case 'nand': v = 1; for (let i = 0; i < ins.length; i++) if (!src[ins[i]]) { v = 0; break; } if (nd.kind === 'nand') v ^= 1; break;
      case 'or': case 'nor': v = 0; for (let i = 0; i < ins.length; i++) if (src[ins[i]]) { v = 1; break; } if (nd.kind === 'nor') v ^= 1; break;
      case 'xor': case 'xnor': v = 0; for (let i = 0; i < ins.length; i++) v ^= src[ins[i]]; if (nd.kind === 'xnor') v ^= 1; break;
      case 'not': v = src[ins[0]] ^ 1; break;
      case 'mux': { let idx = 0; for (let i = 0; i < nd.k; i++) idx += src[ins[i]] << i; v = src[ins[nd.k + idx]]; break; }
      case 'eq': { v = 1; for (let i = 0; i < nd.w; i++) if (src[ins[i]] !== src[ins[nd.w + i]]) { v = 0; break; } break; }
      case 'add': case 'sub': {
        const w = nd.w;
        let a = 0, b = 0;
        for (let i = 0; i < w; i++) { a += src[ins[i]] * 2 ** i; b += src[ins[w + i]] * 2 ** i; }
        let r = nd.kind === 'add' ? a + b : a - b;
        const m = 2 ** w;
        r = ((r % m) + m) % m;
        for (let i = 0; i < w; i++) dst[nd.outs[i]] = Math.floor(r / 2 ** i) % 2;
        return;
      }
    }
    dst[nd.outs[0]] = v;
  }

  // 回路を落ち着かせる。発振したら、揺れている線の集合を返す
  function settle(ck, vals) {
    if (!ck.cyclic) {
      for (const nd of ck.order) evalNode(nd, vals, vals);
      return null;
    }
    const nodes = ck.nodes;
    const limit = nodes.length * 2 + 16;
    let cur = vals, nxt = new Uint8Array(vals.length);
    const round = (mark) => {
      nxt.set(cur);
      for (const nd of nodes) evalNode(nd, cur, nxt);
      let changed = false;
      for (const nd of nodes) for (const o of nd.outs) if (cur[o] !== nxt[o]) { changed = true; if (mark) mark.add(o); }
      const t = cur; cur = nxt; nxt = t;
      return changed;
    };
    let stable = false;
    for (let it = 0; it < limit; it++) if (!round(null)) { stable = true; break; }
    let osc = null;
    if (!stable) {
      osc = new Set();
      for (let it = 0; it < 16; it++) round(osc);
    }
    if (cur !== vals) vals.set(cur);
    return osc;
  }

  const readBus = (nets, vals, osc) => {
    let v = 0;
    for (let i = 0; i < nets.length; i++) {
      if (osc && osc.has(nets[i])) return null;
      v += vals[nets[i]] * 2 ** i;
    }
    return v;
  };
  const writeBus = (nets, vals, v) => { for (let i = 0; i < nets.length; i++) vals[nets[i]] = Math.floor(v / 2 ** i) % 2; };

  function run(src, opts) {
    opts = opts || {};
    let stmts, ck;
    try {
      stmts = parse(String(src == null ? '' : src));
      if (!stmts.length) fail(0, '回路が書かれていません。in、out、名前 = 式 の行を書いてください');
      ck = elaborate(stmts);
      return simulate(stmts, ck, opts);
    } catch (e) {
      if (!(e instanceof LogicError)) throw e;
      return { ok: false, errors: [errObj(e)], warnings: ck ? ck.warnings : [] };
    }
  }

  function simulate(stmts, ck, opts) {
    const warnings = ck.warnings.slice();
    const inByName = new Map(ck.inputs.map((x, i) => [x.name, i]));
    const stateful = ck.cyclic || ck.regs.length > 0;
    const tests = stmts.filter((s) => s.s === 'test');
    const steps = stmts.filter((s) => s.s === 'step' || s.s === 'clock');
    const checkSet = (st, kw) => {
      const seen = new Set();
      for (const a of st.set) {
        const i = inByName.get(a.name);
        if (i === undefined) fail(a.line, `${kw} の ${q(a.name)} は、in で宣言した入力ではありません${near(a.name, inByName.keys())}`);
        if (seen.has(a.name)) fail(a.line, `${kw} に ${q(a.name)} が 2 回あります`);
        seen.add(a.name);
        const w = ck.inputs[i].width;
        if (a.value >= 2 ** w) fail(a.line, `${q(a.name)} は ${w} ビットなので、${a.value} は入りません（0〜${2 ** w - 1}）`);
      }
    };
    const totalBits = ck.inputs.reduce((a, x) => a + x.width, 0);
    const maxBits = opts.maxInputBits || 10;

    let kind, stim;
    // 自分の test / step の書き方は、like があっても確かめる
    tests.forEach((t) => checkSet(t, 'test'));
    steps.forEach((t) => t.s === 'step' && checkSet(t, 'step'));
    if (opts.like && opts.like.stimulus) {
      stim = opts.like.stimulus;
      kind = stim.kind;
      if (kind === 'table' && stateful) fail(0, `この回路は値を記憶します（${ck.regs.length ? 'reg' : '出力が入力に戻る線'}があります）。この問題は、記憶のない回路（組み合わせ回路）で作ってください`);
    } else {
      if (tests.length && steps.length) fail(steps[0].line, `test（真理値表）と step / clock（時間の流れ）は、1 つの回路で一緒には使えません`);
      if (steps.length) {
        kind = 'timing';
        const list = [];
        for (const st of steps) {
          if (st.s === 'clock') for (let i = 0; i < st.n; i++) list.push({ set: {}, line: st.line });
          else list.push({ set: Object.fromEntries(st.set.map((a) => [a.name, a.value])), line: st.line });
          if (list.length > MAX_STEPS) fail(st.line, `ステップが多すぎます（${MAX_STEPS} まで）`);
        }
        stim = { kind, steps: list };
      } else {
        if (stateful) {
          const why = ck.regs.length ? 'reg があるので' : '出力が入力に戻る線（帰還）があるので';
          if (tests.length) fail(tests[0].line, `この回路は${why}、前の状態で結果が変わります。test ではなく、${q('step a=1')} や ${q('clock 4')} で入力を順に与えてください`);
          fail(0, `この回路は${why}、真理値表を作れません。${q('step a=1, b=0')} や ${q('clock 4')} の行で、入力を順に与えてください`);
        }
        kind = 'table';
        if (tests.length) {
          stim = { kind, vectors: tests.map((t) => ({ set: Object.fromEntries(t.set.map((a) => [a.name, a.value])), line: t.line, expect: t.expect })) };
        } else {
          if (totalBits > maxBits) fail(0, `入力が合計 ${totalBits} ビットあり、全部の組み合わせ（${2 ** totalBits} 行）は表にできません。${q('test a=3, b=5')} のような行で、調べたい入力を指定してください`);
          stim = { kind, vectors: null };
        }
      }
    }

    const vals = new Uint8Array(ck.size);
    vals[1] = 1;
    const rows = [];
    const checks = [];
    const outVal = (o, osc) => (o.known ? readBus(o.nets, vals, osc) : null);
    const record = (line, osc) => {
      const row = { in: ck.inputs.map((x) => readBus(x.nets, vals)), out: ck.outputs.map((o) => outVal(o, osc)), wire: ck.wires.map((x) => readBus(x.nets, vals, osc)), line: line || 0 };
      if (osc) row.unstable = true;
      rows.push(row);
      return row;
    };
    const apply = (set) => {
      for (const [k, v] of Object.entries(set)) {
        const i = inByName.get(k);
        if (i === undefined) continue; // like の入力名が違うとき（compare が指摘する）
        writeBus(ck.inputs[i].nets, vals, v % 2 ** ck.inputs[i].width);
      }
    };

    if (kind === 'table') {
      const evalRow = (line) => { settle(ck, vals); return record(line, null); };
      if (stim.vectors) {
        const useExpect = !(opts.like && opts.like.stimulus);
        for (const vec of stim.vectors) {
          for (const x of ck.inputs) writeBus(x.nets, vals, 0);
          apply(vec.set);
          const row = evalRow(vec.line);
          if (useExpect && vec.expect) {
            let pass = true;
            for (const a of vec.expect) {
              let oi = ck.outputs.findIndex((o) => o.name === a.name), got;
              if (oi >= 0) got = row.out[oi];
              else {
                oi = ck.wires.findIndex((o) => o.name === a.name);
                if (oi < 0) fail(a.line, `test の ${q('->')} の右の ${q(a.name)} は、出力（out）の名前ではありません${near(a.name, ck.outputs.map((o) => o.name))}`);
                got = row.wire[oi];
              }
              const ok = got === a.value;
              if (!ok) pass = false;
              const ins = vec.set && Object.keys(vec.set).length ? Object.entries(vec.set).map(([k, v]) => `${k}=${v}`).join(', ') : '入力がすべて 0';
              checks.push({ line: a.line, ok, msg: ok ? `${a.line} 行目：${ins} のとき ${a.name}=${a.value}（合っています）` : `${a.line} 行目：${ins} のとき、${q(a.name)} は ${a.value} のはずですが、${got === null ? '値が決まっていません' : got + ' になりました'}` });
            }
            row.pass = pass;
          }
        }
      } else {
        const n = 2 ** totalBits;
        for (let r = 0; r < n; r++) {
          // 最初に宣言した入力が上の桁
          let rest = r;
          for (let i = ck.inputs.length - 1; i >= 0; i--) {
            const m = 2 ** ck.inputs[i].width;
            writeBus(ck.inputs[i].nets, vals, rest % m);
            rest = Math.floor(rest / m);
          }
          evalRow(0);
        }
      }
    } else {
      for (const r of ck.regs) vals[r.q] = r.init;
      let warned = false;
      stim.steps.forEach((st, i) => {
        apply(st.set);
        const osc = settle(ck, vals);
        record(st.line, osc);
        if (osc && !warned) {
          warned = true;
          const names = [...ck.outputs, ...ck.wires].filter((x) => x.nets.some((n) => osc.has(n))).map((x) => x.name);
          const ins = ck.inputs.map((x) => `${x.name}=${readBus(x.nets, vals)}`).join(', ');
          warnings.push({ line: st.line || 0, msg: `${st.line ? st.line + ' 行目：' : ''}${i + 1} ステップ目${ins ? `（${ins}）` : ''}で、回路が落ち着きません（発振）。${names.length ? `${names.map(q).join('、')} が 0 と 1 を行き来し続けます。` : ''}表では ? と表示します` });
        }
        if (ck.regs.length) {
          const nextv = ck.regs.map((r) => vals[r.d]);
          ck.regs.forEach((r, k) => { vals[r.q] = nextv[k]; });
        }
      });
    }

    const pub = (x) => ({ name: x.name, width: x.width });
    const res = {
      ok: true, kind,
      inputs: ck.inputs.map(pub), outputs: ck.outputs.map(pub),
      wires: ck.wires.map((x) => ({ name: x.name, width: x.width, kind: x.kind })),
      rows, checks, gates: ck.gates, warnings, errors: [], stimulus: stim,
    };
    if (kind === 'timing') {
      res.clocked = ck.regs.length > 0;
      const wave = [];
      if (res.clocked) wave.push({ name: 'clk', width: 1, kind: 'clock', values: null });
      ck.inputs.forEach((x, i) => wave.push({ name: x.name, width: x.width, kind: 'in', values: rows.map((r) => r.in[i]) }));
      ck.wires.forEach((x, i) => wave.push({ name: x.name, width: x.width, kind: x.kind, values: rows.map((r) => r.wire[i]) }));
      ck.outputs.forEach((x, i) => wave.push({ name: x.name, width: x.width, kind: x.isReg ? 'reg' : 'out', values: rows.map((r) => r.out[i]) }));
      res.wave = wave;
    }
    return res;
  }

  // ------------------------------------------------------------------ 比較
  function fmt(v, width, base) {
    if (v === null || v === undefined) return '?';
    if (base === 'bin') return v.toString(2).padStart(width || 1, '0');
    if (base === 'hex') return '0x' + v.toString(16).padStart(Math.ceil((width || 1) / 4), '0');
    return String(v);
  }
  const fmtBoth = (v, width) => (v === null ? '?' : width > 1 ? `${v}（2 進 ${fmt(v, width, 'bin')}）` : String(v));

  function compare(exp, got) {
    if (!exp || !exp.ok) return { ok: false, reason: 'error', msg: '期待する結果（模範解答）がエラーです' };
    if (!got || !got.ok) return { ok: false, reason: 'error', msg: got && got.errors && got.errors[0] ? got.errors[0].msg : 'エラーで実行できませんでした' };
    if (exp.kind !== got.kind) return { ok: false, reason: 'kind', msg: exp.kind === 'table' ? '真理値表を出す回路（step / clock のない回路）にしてください' : 'タイミング表を出す回路（step / clock で入力を与える回路）にしてください' };
    const names = (xs) => xs.map((x) => x.name);
    const nameDiff = (label, reason, E, G) => {
      const missing = names(E).filter((n) => !names(G).includes(n));
      const extra = names(G).filter((n) => !names(E).includes(n));
      if (!missing.length && !extra.length) return null;
      const parts = [];
      if (missing.length) parts.push(`${missing.map(q).join('、')} がありません`);
      if (extra.length) parts.push(`${extra.map(q).join('、')} は余分です`);
      return { ok: false, reason, missing, extra, msg: `${label}の名前が違います。${parts.join('。')}（期待：${names(E).join(', ') || 'なし'}　あなたの回路：${names(G).join(', ') || 'なし'}）` };
    };
    const widthDiff = (label, reason, E, G) => {
      for (const e of E) {
        const g = G.find((x) => x.name === e.name);
        if (g.width !== e.width) return { ok: false, reason, name: e.name, expected: e.width, actual: g.width, msg: `${label} ${q(e.name)} のビット幅が違います（期待は ${e.width} ビット、あなたの回路は ${g.width} ビット）` };
      }
      return null;
    };
    const d = nameDiff('入力', 'inputs', exp.inputs, got.inputs) || widthDiff('入力', 'input-width', exp.inputs, got.inputs) ||
      nameDiff('出力', 'outputs', exp.outputs, got.outputs) || widthDiff('出力', 'output-width', exp.outputs, got.outputs);
    if (d) return d;
    if (exp.rows.length !== got.rows.length) return { ok: false, reason: 'rows', msg: `行数が違います（期待は ${exp.rows.length} 行、あなたの回路は ${got.rows.length} 行）` };

    const inMap = exp.inputs.map((e) => got.inputs.findIndex((g) => g.name === e.name));
    const outMap = exp.outputs.map((e) => got.outputs.findIndex((g) => g.name === e.name));
    let gotRow;
    if (exp.kind === 'table') {
      const index = new Map();
      got.rows.forEach((r) => { const k = inMap.map((j) => r.in[j]).join(','); if (!index.has(k)) index.set(k, []); index.get(k).push(r); });
      gotRow = (r) => { const list = index.get(r.in.join(',')); return list && list.length ? list.shift() : null; };
    } else gotRow = (r, i) => got.rows[i];

    let first = null, mismatches = 0;
    exp.rows.forEach((er, i) => {
      const gr = gotRow(er, i);
      let badRow = false;
      exp.outputs.forEach((o, k) => {
        const ev = er.out[k], gv = gr ? gr.out[outMap[k]] : null;
        if (ev === gv) return;
        badRow = true;
        if (!first) first = { row: i, name: o.name, width: o.width, expected: ev, actual: gv, unstable: !!(gr && gr.unstable) };
      });
      if (badRow) mismatches++;
    });
    if (!first) return { ok: true, reason: 'same', msg: '一致しました' };
    const er = exp.rows[first.row];
    const input = Object.fromEntries(exp.inputs.map((x, i) => [x.name, er.in[i]]));
    const ins = exp.inputs.map((x, i) => `${x.name}=${er.in[i]}`).join(', ');
    const where = exp.kind === 'table'
      ? (ins ? `入力が ${ins} のとき` : '') + `（表の ${first.row + 1} 行目）`
      : `ステップ ${first.row + 1}${ins ? `（${ins}）` : ''}で`;
    const unknown = first.actual === null;
    const msg = unknown
      ? `${where}、出力 ${q(first.name)} は ${fmtBoth(first.expected, first.width)} のはずですが、${first.unstable ? '回路が落ち着かず（発振）、値が決まっていません' : '値が決まっていません'}`
      : `${where}、出力 ${q(first.name)} は ${fmtBoth(first.expected, first.width)} のはずですが、${fmtBoth(first.actual, first.width)} になっています`;
    return { ok: false, reason: unknown ? 'unknown' : 'value', row: first.row, input, name: first.name, expected: first.expected, actual: first.actual, mismatches, msg: msg + (mismatches > 1 ? `（ほかに ${mismatches - 1} 行で違いがあります）` : '') };
  }

  function limits(result, lim) {
    lim = lim || {};
    const problems = [];
    if (!result || !result.ok) return { ok: false, problems: [{ line: 0, msg: '回路がエラーなので調べられません' }], msg: '回路がエラーなので調べられません' };
    const g = result.gates;
    if (lim.only) {
      const allowed = (Array.isArray(lim.only) ? lim.only : String(lim.only).split(/[\s,]+/)).map((s) => s.toLowerCase()).filter(Boolean);
      for (const kind of Object.keys(g.byKind)) {
        if (allowed.includes(kind)) continue;
        const line = g.where[kind][0];
        const nm = { add: '+', sub: '-', eq: '==' }[kind] || kind;
        problems.push({ line, msg: `${line} 行目：${q(nm)} は使えません。この問題で使えるゲートは ${allowed.join('、')} だけです（${q(nm)} を ${g.byKind[kind]} 個使っています）` });
      }
      problems.sort((a, b) => a.line - b.line);
    }
    if (lim.maxgates !== undefined && lim.maxgates !== null && lim.maxgates !== '' && g.total > Number(lim.maxgates)) {
      problems.push({ line: 0, msg: `ゲートを ${g.total} 個使っています。この問題は ${Number(lim.maxgates)} 個までです` });
    }
    return { ok: !problems.length, problems, msg: problems.map((p) => p.msg).join('\n') };
  }

  function grade(answerSrc, userSrc, lim) {
    const exp = run(answerSrc);
    if (!exp.ok) return { ok: false, reason: 'answer-error', msg: '模範解答がエラーです：' + exp.errors[0].msg, exp, got: null };
    const got = run(userSrc, { like: exp });
    const c = compare(exp, got);
    if (!c.ok) return { ...c, exp, got };
    const l = limits(got, lim);
    if (!l.ok) return { ok: false, reason: 'limits', msg: l.msg, problems: l.problems, exp, got };
    return { ...c, exp, got };
  }

  function text(result) {
    if (!result.ok) return result.errors.map((e) => e.msg).join('\n');
    const cols = [...result.inputs.map((x, i) => ({ h: x.name, w: x.width, get: (r) => r.in[i] })), null, ...result.outputs.map((x, i) => ({ h: x.name, w: x.width, get: (r) => r.out[i] }))];
    const cells = [cols.map((c) => (c ? c.h : '|'))];
    result.rows.forEach((r) => cells.push(cols.map((c) => (c ? fmt(c.get(r), c.w) : '|'))));
    const widths = cols.map((_, j) => Math.max(...cells.map((row) => row[j].length)));
    return cells.map((row) => row.map((s, j) => s.padStart(widths[j])).join(' ')).join('\n');
  }

  root.LOGIC = { run, compare, limits, grade, fmt, text, GATE_KINDS };
})(typeof window !== 'undefined' ? window : globalThis);
