// 図解 CPU の中心部品：RISC-V（RV32IM）のアセンブラ・逆アセンブラ・エミュレータ。
// DOM を使わない。ブラウザでは <script src="rv.js"> で window.RV、Node では import すると globalThis.RV ができる。
//
// ───────────────────────────── API ─────────────────────────────
//
// ■ アセンブル
//   const prog = RV.assemble(src)
//     prog.ok          成功なら true
//     prog.errors      [{ line, msg, text }]  line は 1 始まり。msg は理由、text は「3 行目：理由」の形。行番号順
//     prog.errorText   text を改行でつないだもの（成功なら ''）
//     prog.words       Uint32Array  .text の中身（0 番地から 4 バイトずつ）
//     prog.text        Uint8Array   .text のバイト列（words と同じ中身）
//     prog.data        Uint8Array   .data のバイト列（0x8000 番地から置かれる）
//     prog.textEnd     .text の終わりの番地（＝ バイト数）。pc がここに来たら「最後まで実行した」
//     prog.dataEnd     .data の終わりの番地
//     prog.entry       実行を始める番地。ラベル _start があればそこ、なければ main、どちらもなければ 0
//     prog.symbols     { ラベル名: 番地 }（.equ の定数は入らない）
//     prog.consts      { 名前: 値 }（.equ / .set / 名前 = 値）
//     prog.lineOf(pc)  その番地の命令・データを書いた行番号（なければ 0）。疑似命令が 2 語に展開されたら 2 語とも同じ行
//     prog.pcOf(line)  その行の最初の命令の番地（命令のない行は -1）
//     prog.labelAt(addr)  その番地に付いたラベル名（なければ ''）
//     prog.listing     [{ pc, word, line, asm, src }]  .text の 1 語ごと。asm は逆アセンブル結果、src は元の行
//     prog.source      元のソースを行ごとに分けた配列
//
// ■ 逆アセンブルと命令の分解
//   RV.disasm(word, pc = 0, opts)   → 'addi a0, a0, -1' のような文字列。命令でなければ '.word 0x........'
//     opts.pseudo  false にすると疑似命令（ret, mv, li, j, beqz …）に直さない（既定は直す）
//     opts.symbols prog.symbols を渡すと、分岐・ジャンプの飛び先をラベル名で出す（渡さなければ 0x10 のような絶対番地）
//     逆アセンブルした文字列は、同じ pc に置けば RV.assemble で同じ機械語に戻る
//   RV.decode(word, pc = 0)  → {
//       word, hex ('0x00100513'), bin (32 文字), valid, name ('addi' / 不正なら null), format ('R' 'I' 'S' 'B' 'U' 'J'),
//       opcode, rd, rs1, rs2, funct3, funct7, imm（符号拡張ずみ。U 形式は 12 ビット左に寄せた値）, csr,
//       cls ('arith' 'muldiv' 'load' 'store' 'branch' 'jump' 'system'),
//       fields: [{ name, kind, hi, lo, bits, value, text }]   // 上位ビットから順。name は 'funct7' 'rs2' 'imm[11:0]' など、
//                                                             // kind は 'opcode' 'rd' 'rs1' 'rs2' 'funct3' 'funct7' 'imm' 'shamt' 'csr'、
//                                                             // text は rd/rs1/rs2 なら 'a0' のようなレジスタ名
//       asm, asmRaw（疑似命令に直さない形） }
//   RV.encode(line, pc = 0)  → 1 行をアセンブルした語の配列（エラーなら例外）。手早く機械語を得る用
//
// ■ 機械
//   const m = RV.machine({ maxSteps, seed, pipeline, cache })
//     maxSteps  run 1 回で実行する命令数の上限（既定 1,000,000）
//     seed      乱数のシード（既定は固定値。同じプログラムは毎回同じ結果）
//     pipeline  true か { forwarding: true|false, predictor: 'none'|'taken'|'1bit'|'2bit', penalty: 2, entries: 256, rows: 64 }
//     cache     true か '容量,ブロック,連想度' の文字列か { size: 256, block: 16, ways: 1, missPenalty: 10, history: 2000 }
//   m.load(prog)   機械を初期化してプログラムを置く。prog.ok でなければ例外。m を返す
//                  初期値：pc = prog.entry、sp = 0x10000、gp = 0x8000、ra = prog.textEnd（main から ret すると終わる）
//   m.reset()      同じプログラムを最初から
//   m.run({ until: 'halt' | 'frame', limit })  → 結果 r
//     until: 'frame' なら、0x20010 への書き込み（1 フレーム終わり）でも止まる。もう一度 run すると続きを実行する
//     r = { reason, exitCode, error, message, steps, ran }
//       reason   'exit'（ecall 10 / 93）'end'（.text の最後まで来た）'frame' 'limit'（上限。続きは run で再開できる）
//                'break'（ebreak。再開できる）'error'（実行時エラー）
//       exitCode exit のときの終了コード（それ以外は null）
//       error    error のとき { msg, detail, pc, line, asm, cause, causeName, tval }。msg は
//                「0x0000001c 番地の `lw t0, 3(a0)`（8 行目）：番地 0x00008003 は 4 の倍数ではないので lw で読めません…」
//       message  どの理由でも、そのまま表示できる日本語の 1 文
//       steps    これまでに実行した命令数、ran はこの run で実行した命令数
//     exit / end / error のあとは、run や step を呼んでも同じ結果が返るだけ（m.halted でも見られる）
//   m.step()  1 命令だけ実行 → {
//       done      true なら何も実行していない（もう終わっている）
//       reason    この命令で終わったら 'exit' 'end' 'error' 'break'、続けられるなら null
//       result    終わったときの run と同じ形の結果（続けられるなら null）
//       pc, word, asm, line, name, cls, format   実行した命令
//       reads     [{ reg, name, value }]                 読んだレジスタ（zero も入る。ecall は a7 と a0）
//       writes    [{ reg, name, before, after }]         書いたレジスタ（x0 への書き込みは入らない）
//       mem       [{ rw: 'r'|'w', addr, width, value, before, region }]
//                    region は 'ram' 'screen' 'io'。value は幅ぶんの符号なしの値。before は書き込みの前の値（io は null）
//       nextPc    次に実行する番地
//       branch    分岐・ジャンプなら { taken, target }、それ以外は null
//       io        [{ type: 'console', text } | { type: 'screen', addr, x, y, color } | { type: 'frame' } |
//                  { type: 'key', code } | { type: 'random', value } | { type: 'cycle', value } | { type: 'exit', code }]
//       trap      トラップが起きて mtvec に飛んだら { cause, causeName, tval, handler }、なければ null
//       alu       { a, b, op, result }  データパスの図用（ALU の 2 つの入力・演算の記号・結果）。ecall や CSR 命令は null
//                 ロード・ストアの result は番地、分岐は 1（成立）か 0、ジャンプは飛び先
//       control   { regWrite, aluSrc: 'rs2'|'imm', memRead, memWrite, memToReg, branch, jump }  制御信号
//       error     reason が 'error' のときのエラー（run と同じ形） }
//   m.regs      Int32Array(32)  符号付きで入っている。符号なしで見るなら RV.u32(m.regs[10])
//   m.pc        いまの pc（代入もできる）
//   m.mem       Uint8Array(0x10000)  RAM。外から書き換えるときは m.write8 / m.write32 を使う（命令のキャッシュを消すため）
//   m.screen    Uint8Array(1024)  画面。1 バイト 1 ピクセル、値は色番号 0〜15（書き込みの下位 4 ビットだけ残る）
//   m.screenUsed  画面か 0x20010 に 1 度でも書いたら true
//   m.frames    0x20010 に書いた回数
//   m.console   コンソールに出た文字列
//   m.steps     実行した命令数
//   m.halted    終わっていれば結果、まだなら null
//   m.stats     { steps, byOp: { addi: 12, … }, byClass: { arith, muldiv, load, store, branch, jump, system }, branches, taken }
//   m.reg(名前か番号) / m.setReg(名前か番号, 値)
//   m.read8(a) m.read16(a) m.read32(a)   副作用なしで読む（RAM と画面。それ以外は null）
//   m.write8(a, v) m.write32(a, v)        RAM と画面に書く
//   m.readString(a)                       NUL までを UTF-8 の文字列として読む
//   m.keyDown(code) / m.keyUp(code) / m.key(code)   キー入力。code は RV.keyCode(event.key) で作る
//   m.snapshot() / m.restore(s)   機械の状態を丸ごと保存・復元（1 つ約 70 KB。計測の状態も含む）。
//                                 「1 命令戻る」は、step の前に snapshot を取っておき restore する（溜める個数は画面側で絞る）
//   m.priv      いまの特権モード（3 = M、0 = U）
//   m.csr       { mstatus, mtvec, mepc, mcause, mtval, mscratch, mie, mip }
//   m.pipeline  パイプラインの計測（下）。指定しなければ null
//   m.cache     キャッシュの計測（下）。指定しなければ null
//   m.timing    { instructions, cycles, cpi, pipelineCycles, cachePenalty }  両方を合わせたサイクル数
//               （pipeline なしなら 1 命令 1 サイクルとして数える）
//
// ■ まとめて実行
//   RV.run(src, opts)  → { ok, prog, machine, result, console, errors }
//     アセンブルして新しい機械で run する。opts は RV.machine と同じ（+ until, limit）。
//     ok はアセンブルでき、実行時エラーもなかったら true。アセンブルエラーなら machine と result は null、errors に理由
//
// ■ メモリマップ（RV.MAP に同じ値がある）
//   0x00000〜0x0FFFF  RAM 64 KiB。.text は 0x0000 から、.data は 0x8000 から（どちらも最大 32 KiB）。スタックは 0x10000 から下へ
//   0x10000〜0x103FF  画面 32 × 32。(x, y) は 0x10000 + y*32 + x。色は RV.PALETTE[番号]（'#rrggbb'）、名前は RV.PALETTE_NAMES
//   0x20000  コンソール出力（書いた 1 バイトを UTF-8 として組み立てて出す）
//   0x20004  キーボード（読むと押されたキーのコード、なければ 0。読むと消える。← 1、↑ 2、→ 3、↓ 4、他は ASCII。16 個まで溜まる）
//   0x20008  乱数（読むたびに 32 ビットの擬似乱数。書くとシードを変える）
//   0x2000C  実行した命令数の下位 32 ビット
//   0x20010  書くと「1 フレーム終わり」。読むとこれまでのフレーム数
//   0x20014  いま押されているキー（ビット 0 ←、1 ↑、2 →、3 ↓、4 スペース）。設計書にない追加。ゲームの「押しっぱなし」用
//   どの I/O も lw / lbu などどの幅でも読める。書き込みは sb / sw どれでもよい（コンソールは下位 1 バイトだけ使う）
//
// ■ ecall（a7 に番号。RARS と同じ。RV.ECALLS に一覧）
//   1 = a0 を 10 進（符号付き）で表示、4 = a0 の番地の文字列（NUL 終端、UTF-8）を表示、11 = a0 の文字を表示、
//   34 = a0 を 16 進（0x と 8 桁）で表示、35 = a0 を 2 進（32 桁）で表示、36 = a0 を符号なし 10 進で表示、
//   10 = 終了（終了コード 0）、93 = a0 を終了コードにして終了
//
// ■ 例外とトラップ
//   範囲外の番地、整列していない lw/sw/lh/sh、不正な命令、知らない番号の ecall は例外。
//   mtvec が 0（設定していない）なら、エラーとして止まる（reason 'error'）。
//   mtvec を設定してあれば、mepc・mcause・mtval・mstatus を入れて mtvec に飛ぶ（M モードになる）。mret で戻る。
//   mcause：0 命令アドレスの整列違反、1 命令アクセス違反、2 不正な命令、3 ブレークポイント、4 ロードの整列違反、
//           5 ロードのアクセス違反、6 ストアの整列違反、7 ストアのアクセス違反、8 U モードからの ecall、11 M モードからの ecall
//   ecall は、M モード（最初はこれ）ではエミュレータが直接処理する。U モード（mstatus の MPP を 0 にして mret すると入る）で
//   mtvec が設定されていれば、cause 8 のトラップになる（OS のシステムコールの形）。U モードでは CSR 命令と mret は不正な命令。
//   ebreak は、mtvec が 0 なら reason 'break' で止まる（再開できる）。設定してあれば cause 3 のトラップ。
//   割り込み（タイマーなど）はない。
//
// ■ アセンブラの文法
//   ラベル `loop:`（数字のラベル `1:` と `1b` `1f` も可）、コメント `#` と `//`
//   数：10 進、0x、0b、文字 'A'（'\n' '\t' '\r' '\0' '\\' '\'' '\"' '\xHH'）、負数、式（+ - * / & | ^ ~ << >> と括弧）
//   ディレクティブ：.text .data（.section .text/.data/.rodata/.bss）.word（.long）.half（.short）.byte
//     .ascii .asciz .string .space（.zero .skip）.align n（2 の n 乗に揃える）.balign n（n バイトに揃える）
//     .equ 名前, 値（.set、`名前 = 値` も同じ）.globl などは無視
//     .word は 4 の倍数、.half は 2 の倍数の番地に自動で揃える（RARS と同じ）。.data の中に命令は書けない
//   命令：RV32I 全部、M 拡張、csrrw csrrs csrrc csrrwi csrrsi csrrci、mret、wfi（何もしない）、fence（何もしない）
//   疑似命令：li la mv not neg nop j jr ret call tail beqz bnez blez bgez bltz bgtz bgt ble bgtu bleu
//     seqz snez sltz sgtz sgt sgtu、jal ラベル（rd = ra）、jalr rs、csrr csrw csrs csrc csrwi csrsi csrci、
//     lw rd, ラベル（lb lh lbu lhu も）、sw rs, ラベル, 作業用レジスタ（sb sh も）
//     展開：li は値が -2048〜2047 なら addi 1 語、それ以外は lui + addi（下位 12 ビットが 0 なら lui だけ）。
//           la は lui + addi（絶対番地）。call は jal ra, ラベル、tail は jal zero, ラベル（どちらも 1 語）
//   %hi(式) %lo(式)。オペランドは `8(sp)` `(a0)` `%lo(sym)(t0)`。分岐・ジャンプの飛び先に数を書くと絶対番地
//   RV.INSTRUCTIONS（[{ name, format, opcode, funct3, funct7, cls }]）、RV.PSEUDO（[{ name, form, expands }]）が付録用の表
//
// ■ パイプラインのモデル（m.pipeline）
//   古典的な 5 段（IF ID EX MEM WB）。命令を実行した順に、各段に入るサイクルを計算する（サイクルは 1 始まり）。
//   ・forwarding あり：直前のロードの結果をすぐ使うと 1 サイクル停止（ロード使用ハザード）。それ以外は停止なし
//   ・forwarding なし：WB の前半で書き、ID の後半で読める。直前の命令の結果を使うと 2 サイクル、2 つ前なら 1 サイクル停止
//   ・分岐・ジャンプは EX で決まる。予測が外れると penalty（既定 2）サイクルを捨てる
//     predictor 'none' = 常に「成立しない」と予測、'taken' = 常に「成立する」と予測、'1bit' = 前回と同じと予測、
//     '2bit' = 2 ビットの飽和カウンタ（初期値 1 = 弱い不成立）。表は pc で引く（entries 個）。
//     成立と予測したときの飛び先は分かっているものとする。jal / jalr は予測の対象外で、いつも penalty サイクルを捨てる
//   m.pipeline.stats  { instructions, cycles, cpi, stalls: { loadUse, data, total }, flushCycles,
//                       branches, taken, mispredicts, accuracy, jumps, forwarding, predictor, penalty }
//                     cycles = instructions + 4 + stalls.total + flushCycles
//                     （最後に実行した命令の予測が外れても、後ろに命令がないので flushCycles には数えない）
//   m.pipeline.rows   最初の rows 個（既定 64）の命令の図用データ。捨てられた命令（squashed）の行も入る
//     [{ n（何番目に実行したか。捨てられた命令は null）, pc, word, asm, line, squashed,
//        cells: [{ c: サイクル, s: 'IF'|'ID'|'EX'|'MEM'|'WB', wait: 待たされて同じ段にいるなら true }],
//        stall: 停止したサイクル数, stallKind: 'loadUse'|'data'|null, stallReg: 待ったレジスタ名,
//        mispredict: この命令の予測が外れたか, predicted: 予測（分岐だけ。true = 成立）, taken }]
//
// ■ キャッシュのモデル（m.cache）
//   データの読み書き（RAM への load / store）だけを数える。命令の取り出しと I/O は数えない。
//   size（容量、バイト）÷ block（ブロック、バイト）÷ ways（連想度。1 = ダイレクトマップ）= セット数。どれも 2 のべき。
//   置き換えは LRU。書き込みのミスでもブロックを読み込む（write-allocate）。
//   m.cache.stats    { accesses, hits, misses, hitRate, reads, writes, readMisses, writeMisses,
//                      missPenalty, penalty（= misses × missPenalty）, size, block, ways, sets }
//   m.cache.history  最初の history 件（既定 2000）[{ n, pc, addr, write, width, block（ブロックの先頭番地）, set, tag, way,
//                      hit, evicted: 追い出したブロックの先頭番地か null }]
//   m.cache.lines()  いまの中身 [{ set, ways: [{ way, valid, tag, addr（ブロックの先頭番地）, age（小さいほど古い）}] }]
//
// ■ そのほか
//   RV.REG_NAMES（['zero','ra',…]）、RV.regIndex('a0') → 10（なければ -1）、RV.regName(10) → 'a0'
//   RV.hex(v, 桁 = 8) → '0000001c'、RV.u32(v)、RV.keyCode('ArrowLeft') → 1（知らないキーは 0）
//   RV.CSR_NAMES（{ mstatus: 0x300, … }）、RV.CAUSES（mcause の番号 → 日本語名）
(function (root) {
  'use strict';

  const RAM_SIZE = 0x10000, DATA_BASE = 0x8000, SECTION_MAX = 0x8000;
  const SCREEN_BASE = 0x10000, SCREEN_W = 32, SCREEN_H = 32, SCREEN_SIZE = SCREEN_W * SCREEN_H;
  const IO_CONSOLE = 0x20000, IO_KEY = 0x20004, IO_RANDOM = 0x20008, IO_CYCLE = 0x2000c, IO_FRAME = 0x20010, IO_KEYS = 0x20014;
  const MAP = {
    RAM_SIZE, TEXT_BASE: 0, DATA_BASE, STACK_TOP: RAM_SIZE, SCREEN_BASE, SCREEN_W, SCREEN_H,
    CONSOLE: IO_CONSOLE, KEY: IO_KEY, RANDOM: IO_RANDOM, CYCLE: IO_CYCLE, FRAME: IO_FRAME, KEYS: IO_KEYS,
  };
  const PALETTE = ['#000000', '#ffffff', '#ff4d4d', '#3ddc68', '#3b82f6', '#ffd93d', '#4dd9ff', '#ff77c8',
    '#ff9f1c', '#a06cff', '#a0623a', '#9ca3af', '#4b5563', '#15803d', '#1e3a8a', '#ffd7b5'];
  const PALETTE_NAMES = ['黒', '白', '赤', '緑', '青', '黄', '水色', '桃', '橙', '紫', '茶', '灰', '濃い灰', '濃い緑', '紺', '肌色'];
  const ECALLS = [
    { n: 1, does: 'a0 を 10 進の整数（符号付き）で表示' },
    { n: 4, does: 'a0 の番地から始まる文字列（NUL 終端）を表示' },
    { n: 10, does: '終了（終了コード 0）' },
    { n: 11, does: 'a0 の文字を表示' },
    { n: 34, does: 'a0 を 16 進（0x と 8 桁）で表示' },
    { n: 35, does: 'a0 を 2 進（32 桁）で表示' },
    { n: 36, does: 'a0 を符号なしの 10 進で表示' },
    { n: 93, does: 'a0 を終了コードにして終了' },
  ];
  const CAUSES = {
    0: '命令アドレスの整列違反', 1: '命令アクセス違反', 2: '不正な命令', 3: 'ブレークポイント',
    4: 'ロードの整列違反', 5: 'ロードのアクセス違反', 6: 'ストアの整列違反', 7: 'ストアのアクセス違反',
    8: 'U モードからの ecall', 11: 'M モードからの ecall',
  };

  const hex = (v, n) => (v >>> 0).toString(16).padStart(n === undefined ? 8 : n, '0');
  const u32 = (v) => v >>> 0;
  const h0x = (v) => '0x' + hex(v);

  // ───────── レジスタ ─────────
  const REG_NAMES = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
    's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
  const REG_INDEX = Object.create(null);
  REG_NAMES.forEach((n, i) => { REG_INDEX[n] = i; REG_INDEX['x' + i] = i; });
  REG_INDEX.fp = 8;
  const regIndex = (s) => {
    if (typeof s === 'number') return s >= 0 && s < 32 && Number.isInteger(s) ? s : -1;
    const i = REG_INDEX[String(s).trim().toLowerCase()];
    return i === undefined ? -1 : i;
  };
  const regName = (i) => REG_NAMES[i & 31];

  const CSR_NAMES = {
    mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
    mcycle: 0xb00, minstret: 0xb02, cycle: 0xc00, time: 0xc01, instret: 0xc02, mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14,
  };
  const CSR_BY_NUM = {};
  for (const k in CSR_NAMES) CSR_BY_NUM[CSR_NAMES[k]] = k;

  // ───────── 命令の表（エンコード・デコード・実行で共通） ─────────
  // [名前, 形式, opcode, funct3, funct7, 分類, ALU の記号]
  const SPEC_SRC = [
    ['lui', 'U', 0x37, -1, -1, 'arith', 'imm'], ['auipc', 'U', 0x17, -1, -1, 'arith', '+'],
    ['jal', 'J', 0x6f, -1, -1, 'jump', '+'], ['jalr', 'I', 0x67, 0, -1, 'jump', '+'],
    ['beq', 'B', 0x63, 0, -1, 'branch', '=='], ['bne', 'B', 0x63, 1, -1, 'branch', '!='], ['blt', 'B', 0x63, 4, -1, 'branch', '<'],
    ['bge', 'B', 0x63, 5, -1, 'branch', '>='], ['bltu', 'B', 0x63, 6, -1, 'branch', '<u'], ['bgeu', 'B', 0x63, 7, -1, 'branch', '>=u'],
    ['lb', 'I', 0x03, 0, -1, 'load', '+'], ['lh', 'I', 0x03, 1, -1, 'load', '+'], ['lw', 'I', 0x03, 2, -1, 'load', '+'],
    ['lbu', 'I', 0x03, 4, -1, 'load', '+'], ['lhu', 'I', 0x03, 5, -1, 'load', '+'],
    ['sb', 'S', 0x23, 0, -1, 'store', '+'], ['sh', 'S', 0x23, 1, -1, 'store', '+'], ['sw', 'S', 0x23, 2, -1, 'store', '+'],
    ['addi', 'I', 0x13, 0, -1, 'arith', '+'], ['slti', 'I', 0x13, 2, -1, 'arith', '<'], ['sltiu', 'I', 0x13, 3, -1, 'arith', '<u'],
    ['xori', 'I', 0x13, 4, -1, 'arith', '^'], ['ori', 'I', 0x13, 6, -1, 'arith', '|'], ['andi', 'I', 0x13, 7, -1, 'arith', '&'],
    ['slli', 'I', 0x13, 1, 0x00, 'arith', '<<'], ['srli', 'I', 0x13, 5, 0x00, 'arith', '>>u'], ['srai', 'I', 0x13, 5, 0x20, 'arith', '>>'],
    ['add', 'R', 0x33, 0, 0x00, 'arith', '+'], ['sub', 'R', 0x33, 0, 0x20, 'arith', '-'], ['sll', 'R', 0x33, 1, 0x00, 'arith', '<<'],
    ['slt', 'R', 0x33, 2, 0x00, 'arith', '<'], ['sltu', 'R', 0x33, 3, 0x00, 'arith', '<u'], ['xor', 'R', 0x33, 4, 0x00, 'arith', '^'],
    ['srl', 'R', 0x33, 5, 0x00, 'arith', '>>u'], ['sra', 'R', 0x33, 5, 0x20, 'arith', '>>'], ['or', 'R', 0x33, 6, 0x00, 'arith', '|'],
    ['and', 'R', 0x33, 7, 0x00, 'arith', '&'],
    ['mul', 'R', 0x33, 0, 0x01, 'muldiv', '*'], ['mulh', 'R', 0x33, 1, 0x01, 'muldiv', '*h'], ['mulhsu', 'R', 0x33, 2, 0x01, 'muldiv', '*hsu'],
    ['mulhu', 'R', 0x33, 3, 0x01, 'muldiv', '*hu'], ['div', 'R', 0x33, 4, 0x01, 'muldiv', '/'], ['divu', 'R', 0x33, 5, 0x01, 'muldiv', '/u'],
    ['rem', 'R', 0x33, 6, 0x01, 'muldiv', '%'], ['remu', 'R', 0x33, 7, 0x01, 'muldiv', '%u'],
    ['fence', 'I', 0x0f, 0, -1, 'system', ''], ['ecall', 'I', 0x73, 0, -1, 'system', ''], ['ebreak', 'I', 0x73, 0, -1, 'system', ''],
    ['mret', 'I', 0x73, 0, -1, 'system', ''], ['wfi', 'I', 0x73, 0, -1, 'system', ''],
    ['csrrw', 'I', 0x73, 1, -1, 'system', ''], ['csrrs', 'I', 0x73, 2, -1, 'system', ''], ['csrrc', 'I', 0x73, 3, -1, 'system', ''],
    ['csrrwi', 'I', 0x73, 5, -1, 'system', ''], ['csrrsi', 'I', 0x73, 6, -1, 'system', ''], ['csrrci', 'I', 0x73, 7, -1, 'system', ''],
  ];
  const NOPS = SPEC_SRC.length;
  const OP = Object.create(null);        // 名前 → 番号（1 始まり）
  const SPEC = Object.create(null);      // 名前 → { op, fmt, opcode, f3, f7 }
  const OP_NAME = [''], OP_FMT = [''], OP_CLS = [''], OP_ALU = [''];
  const OP_R1 = new Uint8Array(NOPS + 2), OP_R2 = new Uint8Array(NOPS + 2), OP_W = new Uint8Array(NOPS + 2);
  const OP_MEM = new Uint8Array(NOPS + 2), OP_WIDTH = new Uint8Array(NOPS + 2), OP_CTL = new Uint8Array(NOPS + 2);
  SPEC_SRC.forEach((s, i) => {
    const op = i + 1, n = s[0];
    OP[n] = op; SPEC[n] = { op, name: n, fmt: s[1], opcode: s[2], f3: s[3], f7: s[4] };
    OP_NAME.push(n); OP_FMT.push(s[1]); OP_CLS.push(s[5]); OP_ALU.push(s[6]);
    const sys = s[5] === 'system';
    const csr = /^csr/.test(n), csri = /^csrr.i$/.test(n);
    OP_R1[op] = (s[1] === 'U' || s[1] === 'J' || (sys && !csr) || csri) ? 0 : 1;
    OP_R2[op] = (s[1] === 'R' || s[1] === 'B' || s[1] === 'S') ? 1 : 0;
    OP_W[op] = (s[1] === 'B' || s[1] === 'S' || (sys && !csr)) ? 0 : 1;
    OP_MEM[op] = s[5] === 'load' ? 1 : s[5] === 'store' ? 2 : 0;
    OP_WIDTH[op] = /^(lb|lbu|sb)$/.test(n) ? 1 : /^(lh|lhu|sh)$/.test(n) ? 2 : OP_MEM[op] ? 4 : 0;
    OP_CTL[op] = s[5] === 'branch' ? 1 : s[5] === 'jump' ? 2 : 0;
  });
  const O = OP;
  const OP_ILLEGAL = 255;
  const SYS_WORDS = { ecall: 0x00000073, ebreak: 0x00100073, mret: 0x30200073, wfi: 0x10500073, fence: 0x0ff0000f };

  const BR_OPS = [O.beq, O.bne, 0, 0, O.blt, O.bge, O.bltu, O.bgeu];
  const LD_OPS = [O.lb, O.lh, O.lw, 0, O.lbu, O.lhu, 0, 0];
  const ST_OPS = [O.sb, O.sh, O.sw, 0, 0, 0, 0, 0];
  const OPI_OPS = [O.addi, 0, O.slti, O.sltiu, O.xori, 0, O.ori, O.andi];
  const OPR_OPS = [O.add, O.sll, O.slt, O.sltu, O.xor, O.srl, O.or, O.and];
  const CSR_OPS = [0, O.csrrw, O.csrrs, O.csrrc, 0, O.csrrwi, O.csrrsi, O.csrrci];

  // 機械語 1 語を分解する。op = 0 は命令ではない
  function dec(w) {
    w >>>= 0;
    const opc = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
    let op = 0, imm = 0;
    switch (opc) {
      case 0x37: op = O.lui; imm = (w & 0xfffff000) | 0; break;
      case 0x17: op = O.auipc; imm = (w & 0xfffff000) | 0; break;
      case 0x6f: op = O.jal; imm = ((w >> 31) << 20) | (w & 0xff000) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1); break;
      case 0x67: if (f3 === 0) { op = O.jalr; imm = w >> 20; } break;
      case 0x63: op = BR_OPS[f3]; imm = ((w >> 31) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1); break;
      case 0x03: op = LD_OPS[f3]; imm = w >> 20; break;
      case 0x23: op = ST_OPS[f3]; imm = ((w >> 25) << 5) | rd; break;
      case 0x13:
        if (f3 === 1) { if (f7 === 0) op = O.slli; imm = rs2; }
        else if (f3 === 5) { if (f7 === 0) op = O.srli; else if (f7 === 0x20) op = O.srai; imm = rs2; }
        else { op = OPI_OPS[f3]; imm = w >> 20; }
        break;
      case 0x33:
        if (f7 === 0) op = OPR_OPS[f3];
        else if (f7 === 0x20) op = f3 === 0 ? O.sub : f3 === 5 ? O.sra : 0;
        else if (f7 === 1) op = O.mul + f3;
        break;
      case 0x0f: if (f3 === 0) op = O.fence; break;
      case 0x73:
        if (f3 === 0) {
          op = w === SYS_WORDS.ecall ? O.ecall : w === SYS_WORDS.ebreak ? O.ebreak : w === SYS_WORDS.mret ? O.mret : w === SYS_WORDS.wfi ? O.wfi : 0;
        } else { op = CSR_OPS[f3]; imm = w >>> 20; }
        break;
    }
    return { op, rd, rs1, rs2, imm, f3, f7, opc, word: w };
  }

  // ───────── エンコード ─────────
  const encR = (s, rd, rs1, rs2) => ((s.f7 << 25) | (rs2 << 20) | (rs1 << 15) | (s.f3 << 12) | (rd << 7) | s.opcode) >>> 0;
  const encI = (s, rd, rs1, imm) => (((imm & 0xfff) << 20) | (rs1 << 15) | (s.f3 << 12) | (rd << 7) | s.opcode) >>> 0;
  const encS = (s, rs2, rs1, imm) => ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (s.f3 << 12) | ((imm & 0x1f) << 7) | s.opcode) >>> 0;
  const encB = (s, rs1, rs2, off) => ((((off >> 12) & 1) << 31) | (((off >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (s.f3 << 12) |
    (((off >> 1) & 0xf) << 8) | (((off >> 11) & 1) << 7) | s.opcode) >>> 0;
  const encU = (s, rd, imm20) => (((imm20 & 0xfffff) << 12) | (rd << 7) | s.opcode) >>> 0;
  const encJ = (s, rd, off) => ((((off >> 20) & 1) << 31) | (((off >> 1) & 0x3ff) << 21) | (((off >> 11) & 1) << 20) | (((off >> 12) & 0xff) << 12) |
    (rd << 7) | s.opcode) >>> 0;
  const encShift = (s, rd, rs1, sh) => ((s.f7 << 25) | ((sh & 31) << 20) | (rs1 << 15) | (s.f3 << 12) | (rd << 7) | s.opcode) >>> 0;

  // ───────── 逆アセンブル ─────────
  const revCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function reverseSymbols(symbols) {
    if (!symbols) return null;
    let r = revCache && revCache.get(symbols);
    if (!r) {
      r = Object.create(null);
      for (const k in symbols) if (!(symbols[k] in r) && !/^\d/.test(k)) r[symbols[k]] = k;
      if (revCache) revCache.set(symbols, r);
    }
    return r;
  }
  function disasm(word, pc, opts) {
    const d = dec(word);
    if (!d.op) return '.word ' + h0x(word);
    pc = (pc >>> 0) || 0;
    const pseudo = !opts || opts.pseudo !== false;
    const rev = opts && opts.symbols ? reverseSymbols(opts.symbols) : null;
    const tgt = (off) => { const a = (pc + off) >>> 0; return rev && rev[a] !== undefined ? rev[a] : '0x' + a.toString(16); };
    const n = OP_NAME[d.op], R = REG_NAMES, rd = R[d.rd], rs1 = R[d.rs1], rs2 = R[d.rs2], imm = d.imm;
    const cls = OP_CLS[d.op];
    if (d.op === O.lui || d.op === O.auipc) return `${n} ${rd}, 0x${((imm >>> 12) & 0xfffff).toString(16)}`;
    if (d.op === O.jal) {
      if (pseudo && d.rd === 0) return `j ${tgt(imm)}`;
      if (pseudo && d.rd === 1) return `jal ${tgt(imm)}`;
      return `jal ${rd}, ${tgt(imm)}`;
    }
    if (d.op === O.jalr) {
      if (pseudo && imm === 0) {
        if (d.rd === 0 && d.rs1 === 1) return 'ret';
        if (d.rd === 0) return `jr ${rs1}`;
        if (d.rd === 1) return `jalr ${rs1}`;
      }
      return `jalr ${rd}, ${imm}(${rs1})`;
    }
    if (cls === 'branch') {
      if (pseudo) {
        if (d.rs2 === 0) {
          const z = { beq: 'beqz', bne: 'bnez', blt: 'bltz', bge: 'bgez' }[n];
          if (z) return `${z} ${rs1}, ${tgt(imm)}`;
        } else if (d.rs1 === 0) {
          const z = { blt: 'bgtz', bge: 'blez' }[n];
          if (z) return `${z} ${rs2}, ${tgt(imm)}`;
        }
      }
      return `${n} ${rs1}, ${rs2}, ${tgt(imm)}`;
    }
    if (cls === 'load') return `${n} ${rd}, ${imm}(${rs1})`;
    if (cls === 'store') return `${n} ${rs2}, ${imm}(${rs1})`;
    if (d.op >= O.csrrw) {
      const c = CSR_BY_NUM[imm] || '0x' + imm.toString(16);
      const isImm = d.op >= O.csrrwi, src = isImm ? String(d.rs1) : rs1;
      if (pseudo) {
        if (d.op === O.csrrs && d.rs1 === 0) return `csrr ${rd}, ${c}`;
        if (d.rd === 0) return `${{ csrrw: 'csrw', csrrs: 'csrs', csrrc: 'csrc', csrrwi: 'csrwi', csrrsi: 'csrsi', csrrci: 'csrci' }[n]} ${c}, ${src}`;
      }
      return `${n} ${rd}, ${c}, ${src}`;
    }
    if (cls === 'system') return n;
    if (OP_FMT[d.op] === 'R') {
      if (pseudo) {
        if (d.op === O.sub && d.rs1 === 0) return `neg ${rd}, ${rs2}`;
        if (d.op === O.sltu && d.rs1 === 0) return `snez ${rd}, ${rs2}`;
        if (d.op === O.slt && d.rs2 === 0) return `sltz ${rd}, ${rs1}`;
        if (d.op === O.slt && d.rs1 === 0) return `sgtz ${rd}, ${rs2}`;
      }
      return `${n} ${rd}, ${rs1}, ${rs2}`;
    }
    // I 形式の演算
    if (pseudo) {
      if (d.op === O.addi) {
        if (d.rd === 0 && d.rs1 === 0 && imm === 0) return 'nop';
        if (d.rs1 === 0) return `li ${rd}, ${imm}`;
        if (imm === 0) return `mv ${rd}, ${rs1}`;
      }
      if (d.op === O.xori && imm === -1) return `not ${rd}, ${rs1}`;
      if (d.op === O.sltiu && imm === 1) return `seqz ${rd}, ${rs1}`;
    }
    return `${n} ${rd}, ${rs1}, ${imm}`;
  }

  function decode(word, pc) {
    word >>>= 0;
    const d = dec(word);
    const bin = word.toString(2).padStart(32, '0');
    const name = d.op ? OP_NAME[d.op] : null;
    let format = d.op ? OP_FMT[d.op] : null;
    if (!format) format = { 0x33: 'R', 0x13: 'I', 0x03: 'I', 0x67: 'I', 0x73: 'I', 0x0f: 'I', 0x23: 'S', 0x63: 'B', 0x37: 'U', 0x17: 'U', 0x6f: 'J' }[d.opc] || null;
    const fields = [];
    const F = (fname, kind, hi, lo, text) => {
      const value = (word >>> lo) & (hi - lo === 31 ? 0xffffffff : (1 << (hi - lo + 1)) - 1);
      fields.push({ name: fname, kind, hi, lo, bits: bin.slice(31 - hi, 32 - lo), value: value >>> 0, text: text === undefined ? '' : text });
    };
    const rdT = REG_NAMES[d.rd], rs1T = REG_NAMES[d.rs1], rs2T = REG_NAMES[d.rs2];
    const shift = d.op === O.slli || d.op === O.srli || d.op === O.srai || (d.opc === 0x13 && (d.f3 === 1 || d.f3 === 5));
    const isCsr = d.opc === 0x73 && d.f3 !== 0;
    switch (format) {
      case 'R': F('funct7', 'funct7', 31, 25); F('rs2', 'rs2', 24, 20, rs2T); F('rs1', 'rs1', 19, 15, rs1T); F('funct3', 'funct3', 14, 12); F('rd', 'rd', 11, 7, rdT); break;
      case 'I':
        if (shift) { F('funct7', 'funct7', 31, 25); F('shamt', 'shamt', 24, 20, String(d.rs2)); }
        else if (isCsr) F('csr', 'csr', 31, 20, CSR_BY_NUM[word >>> 20] || '');
        else F('imm[11:0]', 'imm', 31, 20, String(word >> 20));
        F('rs1', 'rs1', 19, 15, d.op >= O.csrrwi ? String(d.rs1) : rs1T); F('funct3', 'funct3', 14, 12); F('rd', 'rd', 11, 7, rdT); break;
      case 'S': F('imm[11:5]', 'imm', 31, 25); F('rs2', 'rs2', 24, 20, rs2T); F('rs1', 'rs1', 19, 15, rs1T); F('funct3', 'funct3', 14, 12); F('imm[4:0]', 'imm', 11, 7); break;
      case 'B': F('imm[12]', 'imm', 31, 31); F('imm[10:5]', 'imm', 30, 25); F('rs2', 'rs2', 24, 20, rs2T); F('rs1', 'rs1', 19, 15, rs1T); F('funct3', 'funct3', 14, 12);
        F('imm[4:1]', 'imm', 11, 8); F('imm[11]', 'imm', 7, 7); break;
      case 'U': F('imm[31:12]', 'imm', 31, 12); F('rd', 'rd', 11, 7, rdT); break;
      case 'J': F('imm[20]', 'imm', 31, 31); F('imm[10:1]', 'imm', 30, 21); F('imm[11]', 'imm', 20, 20); F('imm[19:12]', 'imm', 19, 12); F('rd', 'rd', 11, 7, rdT); break;
      default: F('?', 'imm', 31, 7);
    }
    F('opcode', 'opcode', 6, 0);
    return {
      word, hex: h0x(word), bin, valid: !!d.op, name, format, cls: d.op ? OP_CLS[d.op] : null,
      opcode: d.opc, rd: d.rd, rs1: d.rs1, rs2: d.rs2, funct3: d.f3, funct7: d.f7, imm: d.imm, csr: isCsr ? word >>> 20 : null,
      fields, asm: disasm(word, pc), asmRaw: disasm(word, pc, { pseudo: false }),
    };
  }

  // ───────── アセンブラ ─────────
  function AsmErr(msg) { this.msg = msg; }
  const fail = (msg) => { throw new AsmErr(msg); };

  function distance(a, b) {
    const m = a.length, n = b.length;
    let prev = [];
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function nearest(word, list) {
    const w = word.toLowerCase();
    let best = null, bd = w.length <= 4 ? 2 : 3;
    for (const c of list) {
      const dd = distance(w, c.toLowerCase());
      if (dd < bd && dd < Math.max(c.length, w.length)) { bd = dd; best = c; }
    }
    return best;
  }

  // 文字列や文字定数の中を飛ばしながら、1 行を走査する。i が引用符の位置なら、その終わりの次の位置を返す
  function skipQuote(s, i) {
    const q = s[i];
    if (q === '"') {
      let j = i + 1;
      while (j < s.length) { if (s[j] === '\\') j += 2; else if (s[j] === '"') return j + 1; else j++; }
      return s.length;
    }
    // 文字定数 'A' '\n' '\x41'
    if (s[i + 1] === '\\') { const e = s.indexOf("'", i + 3); return e > 0 && e - i <= 6 ? e + 1 : i + 1; }
    for (let k = 2; k <= 3; k++) if (s[i + k] === "'") return i + k + 1;
    return i + 1;
  }
  function stripComment(s) {
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipQuote(s, i); continue; }
      if (ch === '#' || (ch === '/' && s[i + 1] === '/')) return s.slice(0, i);
      i++;
    }
    return s;
  }
  function splitOperands(s) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipQuote(s, i); continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth <= 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
      i++;
    }
    const last = s.slice(start).trim();
    if (last !== '' || out.length) out.push(last);
    return out;
  }
  const ESC = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, e: 27 };
  // s の i 文字目（バックスラッシュの次）からエスケープを読む → [値, 次の位置]
  function readEscape(s, i) {
    const ch = s[i];
    if (ch === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
      if (!m) fail('`\\x` の後ろには 16 進の数字を書きます（例：\\x41）');
      return [parseInt(m[0], 16), i + 1 + m[0].length];
    }
    if (ch in ESC) return [ESC[ch], i + 1];
    fail(`エスケープ \`\\${ch === undefined ? '' : ch}\` は使えません（使えるのは \\n \\t \\r \\0 \\\\ \\' \\" \\xHH）`);
  }
  function utf8Bytes(cp, out) {
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  function parseString(s) {
    if (s[0] !== '"' || s.length < 2 || s[s.length - 1] !== '"') fail(`文字列は二重引用符で囲みます（例："Hello"）。\`${s}\` は文字列として読めません`);
    const out = [];
    let i = 1;
    const end = s.length - 1;
    while (i < end) {
      if (s[i] === '\\') { const r = readEscape(s, i + 1); out.push(r[0]); i = r[1]; continue; }
      if (s[i] === '"') fail('文字列の途中に `"` があります。文字として入れるには `\\"` と書きます');
      const cp = s.codePointAt(i);
      utf8Bytes(cp, out);
      i += cp > 0xffff ? 2 : 1;
    }
    if (i > end) fail('文字列が `"` で閉じていません');
    return out;
  }

  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t') { i++; continue; }
      const rest = s.slice(i);
      let m;
      if ((m = /^0[xX]([0-9a-fA-F_]*)/.exec(rest))) {
        if (!m[1] || /^[g-zG-Z]/.test(rest.slice(m[0].length))) fail(`\`${/^\S+/.exec(rest)[0]}\` は 16 進数として読めません（0x の後ろは 0〜9 と a〜f）`);
        toks.push({ t: 'num', v: parseInt(m[1].replace(/_/g, ''), 16) }); i += m[0].length; continue;
      }
      if ((m = /^0[bB]([01_]+)(?![0-9A-Za-z])/.exec(rest))) { toks.push({ t: 'num', v: parseInt(m[1].replace(/_/g, ''), 2) }); i += m[0].length; continue; }
      if ((m = /^\d+[bf](?![0-9A-Za-z_])/.exec(rest))) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^\d+/.exec(rest))) {
        if (/^[A-Za-z_]/.test(rest.slice(m[0].length))) fail(`\`${/^[0-9A-Za-z_]+/.exec(rest)[0]}\` は数として読めません（16 進は 0x、2 進は 0b を前に付けます）`);
        toks.push({ t: 'num', v: parseInt(m[0], 10) }); i += m[0].length; continue;
      }
      if (ch === "'") {
        let v, j;
        if (s[i + 1] === '\\') { const r = readEscape(s, i + 2); v = r[0]; j = r[1]; }
        else if (i + 1 < s.length) { v = s.codePointAt(i + 1); j = i + 1 + (v > 0xffff ? 2 : 1); }
        if (v === undefined || s[j] !== "'") fail("文字は `'A'` のように 1 文字を引用符で囲みます");
        toks.push({ t: 'num', v }); i = j + 1; continue;
      }
      if ((m = /^[A-Za-z_.$][A-Za-z0-9_.$]*/.exec(rest))) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
      if ((m = /^%([A-Za-z_]+)/.exec(rest))) { toks.push({ t: 'pct', v: m[1] }); i += m[0].length; continue; }
      if ((m = /^(<<|>>|[-+*\/&|^~()])/.exec(rest))) { toks.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
      fail(`\`${ch}\` はここには書けません`);
    }
    return toks;
  }
  // 式を計算する。lookup(名前) は値か undefined を返す
  function evalExpr(str, lookup) {
    const toks = tokenize(str);
    if (!toks.length) fail('数かラベルが必要です');
    let p = 0;
    const isOp = (v) => p < toks.length && toks[p].t === 'op' && toks[p].v === v;
    const expect = (v) => { if (!isOp(v)) fail(`\`${v}\` が足りません（\`${str.trim()}\`）`); p++; };
    function prim() {
      const t = toks[p++];
      if (!t) fail(`式 \`${str.trim()}\` が途中で終わっています`);
      if (t.t === 'num') return t.v;
      if (t.t === 'id') {
        const v = lookup(t.v);
        if (v === undefined) {
          const e = new AsmErr(REG_INDEX[t.v.toLowerCase()] !== undefined
            ? `ここには数かラベルを書きます（\`${t.v}\` はレジスタです）`
            : `ラベル \`${t.v}\` が見つかりません`);
          e.undef = t.v;
          throw e;
        }
        return v;
      }
      if (t.t === 'pct') {
        if (t.v !== 'hi' && t.v !== 'lo') fail(`\`%${t.v}\` は使えません（使えるのは %hi と %lo）`);
        expect('(');
        const v = orExpr();
        expect(')');
        return t.v === 'hi' ? ((v + 0x800) >>> 12) & 0xfffff : ((v & 0xfff) << 20) >> 20;
      }
      if (t.v === '(') { const v = orExpr(); expect(')'); return v; }
      if (t.v === '-') return -unary();
      if (t.v === '+') return unary();
      if (t.v === '~') return ~unary();
      fail(`式 \`${str.trim()}\` の \`${t.v}\` の位置が正しくありません`);
    }
    function unary() { return prim(); }
    function mul() {
      let v = unary();
      for (;;) {
        if (isOp('*')) { p++; v = v * unary(); }
        else if (isOp('/')) { p++; const r = unary(); if (r === 0) fail('0 で割っています'); v = Math.trunc(v / r); }
        else return v;
      }
    }
    function add() {
      let v = mul();
      for (;;) {
        if (isOp('+')) { p++; v = v + mul(); }
        else if (isOp('-')) { p++; v = v - mul(); }
        else return v;
      }
    }
    function shift() {
      let v = add();
      for (;;) {
        if (isOp('<<')) { p++; v = v << add(); }
        else if (isOp('>>')) { p++; v = v >>> add(); }
        else return v;
      }
    }
    function andExpr() { let v = shift(); while (isOp('&')) { p++; v = v & shift(); } return v; }
    function xorExpr() { let v = andExpr(); while (isOp('^')) { p++; v = v ^ andExpr(); } return v; }
    function orExpr() { let v = xorExpr(); while (isOp('|')) { p++; v = v | xorExpr(); } return v; }
    const v = orExpr();
    if (p < toks.length) {
      const t = toks[p];
      fail(`\`${str.trim()}\` の \`${t.v}\` の前に、演算子かカンマが足りません`);
    }
    return v;
  }

  const sext12 = (v) => ((v & 0xfff) << 20) >> 20;
  const isRegName = (s) => REG_INDEX[String(s).trim().toLowerCase()] !== undefined;
  const MEM_RE = /^(.*)\(\s*([A-Za-z][A-Za-z0-9]*)\s*\)$/;
  function memForm(s) {
    const m = MEM_RE.exec(s.trim());
    return m && isRegName(m[2]) ? { off: m[1].trim(), reg: m[2] } : null;
  }

  // 命令ごとの組み立て。HANDLERS[名前] = { counts, ex, fn(ops, ctx, 名前) → 語の配列 }
  const HANDLERS = Object.create(null);
  function def(names, counts, ex, fn) {
    for (const n of names.split(' ')) HANDLERS[n] = { counts, ex: ex.replace(/@/g, n), fn };
  }
  const IMM_ALT = { add: 'addi', and: 'andi', or: 'ori', xor: 'xori', slt: 'slti', sltu: 'sltiu', sll: 'slli', srl: 'srli', sra: 'srai' };
  const REG_ALT = { addi: 'add', andi: 'and', ori: 'or', xori: 'xor', slti: 'slt', sltiu: 'sltu', slli: 'sll', srli: 'srl', srai: 'sra' };

  def('add sub sll slt sltu xor srl sra or and mul mulh mulhsu mulhu div divu rem remu', [3], '@ a0, a1, a2', (o, c, mn) => {
    const rd = c.reg(o[0]), rs1 = c.reg(o[1]);
    if (!isRegName(o[2])) {
      const alt = IMM_ALT[mn];
      fail(`\`${mn}\` の 3 つめにはレジスタを書きます（\`${o[2]}\` はレジスタではありません）。` +
        (alt ? `数を使うなら \`${alt}\` です` : mn === 'sub' ? '数を引くなら `addi` に負の数を渡します（例：addi a0, a0, -1）' : '数は先に `li` でレジスタに入れます'));
    }
    return [encR(SPEC[mn], rd, rs1, c.reg(o[2]))];
  });
  def('addi slti sltiu xori ori andi', [3], '@ a0, a1, 10', (o, c, mn) => {
    const rd = c.reg(o[0]), rs1 = c.reg(o[1]);
    if (isRegName(o[2])) fail(`\`${mn}\` の 3 つめには数を書きます（\`${o[2]}\` はレジスタです）。レジスタどうしなら \`${REG_ALT[mn]}\` です`);
    return [encI(SPEC[mn], rd, rs1, c.imm12(o[2], mn))];
  });
  def('slli srli srai', [3], '@ a0, a1, 2', (o, c, mn) => {
    const rd = c.reg(o[0]), rs1 = c.reg(o[1]);
    if (isRegName(o[2])) fail(`\`${mn}\` の 3 つめには数を書きます（\`${o[2]}\` はレジスタです）。レジスタの値だけずらすなら \`${REG_ALT[mn]}\` です`);
    const sh = c.ev(o[2]);
    if (!(sh >= 0 && sh <= 31)) fail(`ずらす量 ${sh} は \`${mn}\` に書けません（0〜31）`);
    return [encShift(SPEC[mn], rd, rs1, sh)];
  });
  def('lb lh lw lbu lhu', [2], '@ t0, 8(sp)', (o, c, mn) => {
    const rd = c.reg(o[0]), m = memForm(o[1]);
    if (m) return [encI(SPEC[mn], rd, c.reg(m.reg), m.off === '' ? 0 : c.imm12(m.off, mn))];
    if (isRegName(o[1])) fail(`\`${mn}\` の 2 つめは \`0(${o[1]})\` のように、ずらす量と括弧で書きます`);
    const a = c.ev(o[1]);
    if (rd === 0) fail(`\`${mn} zero, ラベル\` は書けません（番地を作るのに rd を使うため）`);
    return [encU(SPEC.lui, rd, (a + 0x800) >>> 12), encI(SPEC[mn], rd, rd, sext12(a))];
  });
  def('sb sh sw', [2, 3], '@ t0, 8(sp)', (o, c, mn) => {
    const rs2 = c.reg(o[0]), m = memForm(o[1]);
    if (m) {
      if (o.length === 3) fail(`\`${mn}\` に書くものが多すぎます（例：${mn} t0, 8(sp)）`);
      return [encS(SPEC[mn], rs2, c.reg(m.reg), m.off === '' ? 0 : c.imm12(m.off, mn))];
    }
    if (isRegName(o[1])) fail(`\`${mn}\` の 2 つめは \`0(${o[1]})\` のように、ずらす量と括弧で書きます`);
    if (o.length !== 3) fail(`ラベルの番地に \`${mn}\` で書くときは、番地を作る作業用のレジスタを 3 つめに書きます（例：${mn} t0, ${o[1]}, t1）`);
    const a = c.ev(o[1]), tmp = c.reg(o[2]);
    if (tmp === 0) fail('作業用のレジスタに zero は使えません');
    return [encU(SPEC.lui, tmp, (a + 0x800) >>> 12), encS(SPEC[mn], rs2, tmp, sext12(a))];
  });
  def('beq bne blt bge bltu bgeu', [3], '@ a0, a1, ラベル', (o, c, mn) => [encB(SPEC[mn], c.reg(o[0]), c.reg(o[1]), c.broff(o[2]))]);
  def('bgt ble bgtu bleu', [3], '@ a0, a1, ラベル', (o, c, mn) =>
    [encB(SPEC[{ bgt: 'blt', ble: 'bge', bgtu: 'bltu', bleu: 'bgeu' }[mn]], c.reg(o[1]), c.reg(o[0]), c.broff(o[2]))]);
  def('beqz bnez bltz bgez', [2], '@ a0, ラベル', (o, c, mn) =>
    [encB(SPEC[{ beqz: 'beq', bnez: 'bne', bltz: 'blt', bgez: 'bge' }[mn]], c.reg(o[0]), 0, c.broff(o[1]))]);
  def('blez bgtz', [2], '@ a0, ラベル', (o, c, mn) => [encB(SPEC[mn === 'blez' ? 'bge' : 'blt'], 0, c.reg(o[0]), c.broff(o[1]))]);
  def('lui auipc', [2], '@ a0, 0x12345', (o, c, mn) => {
    const rd = c.reg(o[0]), v = c.ev(o[1]);
    if (!(v >= -0x80000 && v <= 0xfffff)) fail(`\`${mn}\` の数は 20 ビット（0〜0xfffff）です。${v} は入りません。32 ビットの数をそのまま入れるなら \`li\` を使います`);
    return [encU(SPEC[mn], rd, v)];
  });
  def('jal', [1, 2], 'jal ラベル', (o, c) => o.length === 1 ? [encJ(SPEC.jal, 1, c.jmpoff(o[0]))] : [encJ(SPEC.jal, c.reg(o[0]), c.jmpoff(o[1]))]);
  def('j tail', [1], '@ ラベル', (o, c) => [encJ(SPEC.jal, 0, c.jmpoff(o[0]))]);
  def('call', [1], 'call ラベル', (o, c) => [encJ(SPEC.jal, 1, c.jmpoff(o[0]))]);
  def('jalr', [1, 2, 3], 'jalr ra, 0(t0)', (o, c) => {
    if (o.length === 1) {
      const m = memForm(o[0]);
      if (m) return [encI(SPEC.jalr, 1, c.reg(m.reg), m.off === '' ? 0 : c.imm12(m.off, 'jalr'))];
      return [encI(SPEC.jalr, 1, c.reg(o[0]), 0)];
    }
    const rd = c.reg(o[0]);
    if (o.length === 3) return [encI(SPEC.jalr, rd, c.reg(o[1]), c.imm12(o[2], 'jalr'))];
    const m = memForm(o[1]);
    if (m) return [encI(SPEC.jalr, rd, c.reg(m.reg), m.off === '' ? 0 : c.imm12(m.off, 'jalr'))];
    return [encI(SPEC.jalr, rd, c.reg(o[1]), 0)];
  });
  def('jr', [1], 'jr ra', (o, c) => [encI(SPEC.jalr, 0, c.reg(o[0]), 0)]);
  def('ret', [0], 'ret', () => [encI(SPEC.jalr, 0, 1, 0)]);
  def('nop', [0], 'nop', () => [encI(SPEC.addi, 0, 0, 0)]);
  def('ecall ebreak mret wfi fence', [0], '@', (o, c, mn) => [SYS_WORDS[mn]]);
  def('mv', [2], 'mv a0, a1', (o, c) => {
    if (!isRegName(o[1])) fail(`\`mv\` はレジスタからレジスタへの写しです（\`${o[1]}\` はレジスタではありません）。数を入れるなら \`li\` を使います`);
    return [encI(SPEC.addi, c.reg(o[0]), c.reg(o[1]), 0)];
  });
  def('not', [2], 'not a0, a1', (o, c) => [encI(SPEC.xori, c.reg(o[0]), c.reg(o[1]), -1)]);
  def('neg', [2], 'neg a0, a1', (o, c) => [encR(SPEC.sub, c.reg(o[0]), 0, c.reg(o[1]))]);
  def('seqz', [2], 'seqz a0, a1', (o, c) => [encI(SPEC.sltiu, c.reg(o[0]), c.reg(o[1]), 1)]);
  def('snez', [2], 'snez a0, a1', (o, c) => [encR(SPEC.sltu, c.reg(o[0]), 0, c.reg(o[1]))]);
  def('sltz', [2], 'sltz a0, a1', (o, c) => [encR(SPEC.slt, c.reg(o[0]), c.reg(o[1]), 0)]);
  def('sgtz', [2], 'sgtz a0, a1', (o, c) => [encR(SPEC.slt, c.reg(o[0]), 0, c.reg(o[1]))]);
  def('sgt sgtu', [3], '@ a0, a1, a2', (o, c, mn) => [encR(SPEC[mn === 'sgt' ? 'slt' : 'sltu'], c.reg(o[0]), c.reg(o[2]), c.reg(o[1]))]);
  def('li', [2], 'li a0, 100', (o, c) => {
    const rd = c.reg(o[0]);
    if (isRegName(o[1])) fail(`\`li\` の 2 つめには数を書きます（\`${o[1]}\` はレジスタです）。レジスタの値を写すなら \`mv\` です`);
    const v = c.ev(o[1]);
    if (!(v >= -0x80000000 && v <= 0xffffffff)) fail(`${v} は 32 ビットに入りません（-2147483648〜4294967295）`);
    const sv = v | 0;
    if (c.size === 4) {
      if (sv >= -2048 && sv <= 2047) return [encI(SPEC.addi, rd, 0, sv)];
      return [encU(SPEC.lui, rd, (sv + 0x800) >>> 12)];
    }
    return [encU(SPEC.lui, rd, (sv + 0x800) >>> 12), encI(SPEC.addi, rd, rd, sext12(sv))];
  });
  def('la', [2], 'la a0, ラベル', (o, c) => {
    const rd = c.reg(o[0]), a = c.ev(o[1]);
    return [encU(SPEC.lui, rd, (a + 0x800) >>> 12), encI(SPEC.addi, rd, rd, sext12(a))];
  });
  def('csrrw csrrs csrrc', [3], '@ t0, mtvec, t1', (o, c, mn) => [encI(SPEC[mn], c.reg(o[0]), c.reg(o[2]), c.csr(o[1]))]);
  def('csrrwi csrrsi csrrci', [3], '@ t0, mstatus, 8', (o, c, mn) => [encI(SPEC[mn], c.reg(o[0]), c.zimm(o[2]), c.csr(o[1]))]);
  def('csrr', [2], 'csrr t0, mcause', (o, c) => [encI(SPEC.csrrs, c.reg(o[0]), 0, c.csr(o[1]))]);
  def('csrw csrs csrc', [2], '@ mtvec, t0', (o, c, mn) => [encI(SPEC[{ csrw: 'csrrw', csrs: 'csrrs', csrc: 'csrrc' }[mn]], 0, c.reg(o[1]), c.csr(o[0]))]);
  def('csrwi csrsi csrci', [2], '@ mstatus, 8', (o, c, mn) => [encI(SPEC[{ csrwi: 'csrrwi', csrsi: 'csrrsi', csrci: 'csrrci' }[mn]], 0, c.zimm(o[1]), c.csr(o[0]))]);

  const MNEMONICS = Object.keys(HANDLERS);
  const OTHER_ISA = {
    mov: '`mov` はありません。レジスタを写すなら `mv a0, a1`、数を入れるなら `li a0, 5` です',
    movl: '`movl` はありません。レジスタを写すなら `mv`、数を入れるなら `li` です',
    jmp: '`jmp` はありません。無条件のジャンプは `j ラベル` です',
    b: '`b` はありません。無条件のジャンプは `j ラベル` です',
    cmp: '`cmp` はありません。RISC-V では比べる命令と分岐が 1 つになっています（例：blt a0, a1, ラベル）',
    push: '`push` はありません。`addi sp, sp, -4` で場所を空けて `sw ra, 0(sp)` で積みます',
    pop: '`pop` はありません。`lw ra, 0(sp)` で取り出して `addi sp, sp, 4` で戻します',
    inc: '`inc` はありません。`addi a0, a0, 1` と書きます',
    dec: '`dec` はありません。`addi a0, a0, -1` と書きます',
    subi: '`subi` はありません。`addi` に負の数を渡します（例：addi a0, a0, -1）',
    move: '`move` はありません。レジスタを写すのは `mv` です',
    syscall: '`syscall` はありません。RISC-V では `ecall` です',
    int: '`int` はありません。RISC-V では `ecall` です',
    bl: '`bl` はありません。関数を呼ぶのは `call ラベル`（または jal）です',
    muli: '`muli` はありません。数を `li` でレジスタに入れてから `mul` を使います',
    divi: '`divi` はありません。数を `li` でレジスタに入れてから `div` を使います',
    halt: '`halt` はありません。終了するには `li a7, 10` のあと `ecall` です',
    return: '`return` はありません。関数から戻るのは `ret` です',
  };
  const DIRECTIVES = ['.text', '.data', '.word', '.half', '.byte', '.ascii', '.asciz', '.string', '.space', '.align', '.balign', '.equ', '.globl'];
  const IGNORED = { '.globl': 1, '.global': 1, '.local': 1, '.type': 1, '.size': 1, '.option': 1, '.file': 1, '.ident': 1, '.attribute': 1, '.weak': 1, '.p2align': 0 };
  const NAME_RE = /^[A-Za-z_.$][A-Za-z0-9_.$]*$/;

  function assemble(src) {
    const source = String(src === undefined || src === null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const errors = [];
    const err = (line, msg) => { errors.push({ line, msg, text: `${line} 行目：${msg}` }); };
    const symbols = Object.create(null), symLine = Object.create(null), consts = Object.create(null);
    const locals = Object.create(null);
    const items = [];
    const secs = { text: { base: 0, size: 0 }, data: { base: DATA_BASE, size: 0 } };
    let cur = 'text';
    let pending = [];

    function defineLabel(p, addr) {
      if (/^\d+$/.test(p.name)) { (locals[p.name] = locals[p.name] || []).push({ addr, order: items.length }); return; }
      if (p.name in symbols || p.name in consts) { err(p.line, `ラベル \`${p.name}\` は ${symLine[p.name]} 行目でも定義されています。名前を変えます`); return; }
      symbols[p.name] = addr; symLine[p.name] = p.line;
    }
    function flushLabels() {
      const addr = secs[cur].base + secs[cur].size;
      for (const p of pending) defineLabel(p, addr);
      pending = [];
    }
    function alignTo(n) { const s = secs[cur]; s.size += (n - (s.size % n)) % n; }
    function addItem(it, align) {
      if (align > 1) alignTo(align);
      flushLabels();
      it.sec = cur; it.addr = secs[cur].base + secs[cur].size; it.index = items.length;
      items.push(it);
      secs[cur].size += it.size;
    }
    function lookupAt(index) {
      return (name) => {
        const m = /^(\d+)([bf])$/.exec(name);
        if (m) {
          const list = locals[m[1]] || [];
          if (m[2] === 'b') { for (let k = list.length - 1; k >= 0; k--) if (list[k].order <= index) return list[k].addr; }
          else { for (let k = 0; k < list.length; k++) if (list[k].order > index) return list[k].addr; }
          return undefined;
        }
        if (name in consts) return consts[name];
        if (name in symbols) return symbols[name];
        return undefined;
      };
    }
    // 1 回目：まだ決まっていないラベルがあれば undefined
    function tryEv(expr) {
      try { return evalExpr(expr, lookupAt(items.length)); }
      catch (e) { if (e instanceof AsmErr && e.undef) return undefined; throw e; }
    }
    function mustEv(expr, what) {
      const v = tryEv(expr);
      if (v === undefined) fail(`${what}には、この行より前で決まっている数を書きます（\`${expr}\` はまだ決まっていません）`);
      return v;
    }

    function directive(name, rest, line) {
      const ops = splitOperands(rest);
      switch (name) {
        case '.text': flushLabels(); cur = 'text'; return;
        case '.data': case '.rodata': case '.bss': flushLabels(); cur = 'data'; return;
        case '.section': {
          const s = (ops[0] || '').trim();
          if (/^\.text/.test(s)) { flushLabels(); cur = 'text'; }
          else if (/^\.(data|rodata|bss|sdata|sbss)/.test(s)) { flushLabels(); cur = 'data'; }
          else fail(`\`.section ${s}\` は使えません（使えるのは .text と .data）`);
          return;
        }
        case '.word': case '.long': case '.4byte': case '.half': case '.short': case '.2byte': case '.byte': {
          const w = name === '.byte' ? 1 : (name === '.half' || name === '.short' || name === '.2byte') ? 2 : 4;
          if (!ops.length || ops.some((x) => x === '')) fail(`\`${name}\` の後ろに値を書きます（例：${name} 1, 2, 3）`);
          const lo = w === 1 ? -128 : w === 2 ? -32768 : -0x80000000, hi = w === 1 ? 255 : w === 2 ? 65535 : 0xffffffff;
          addItem({
            line, size: w * ops.length, emit(c) {
              const out = [];
              for (const x of ops) {
                if (x[0] === '"') fail(`\`${name}\` に文字列は書けません。文字列は .asciz を使います`);
                const v = c.ev(x);
                if (!(v >= lo && v <= hi)) fail(`${v} は \`${name}\`（${w} バイト）に入りません（${lo}〜${hi}）`);
                for (let k = 0; k < w; k++) out.push((v >>> (8 * k)) & 0xff);
              }
              return { bytes: out };
            },
          }, w);
          return;
        }
        case '.ascii': case '.asciz': case '.string': {
          if (!ops.length) fail(`\`${name}\` の後ろに文字列を書きます（例：${name} "Hello"）`);
          const bytes = [];
          for (const x of ops) { for (const b of parseString(x)) bytes.push(b); if (name !== '.ascii') bytes.push(0); }
          addItem({ line, size: bytes.length, emit: () => ({ bytes }) }, 1);
          return;
        }
        case '.space': case '.zero': case '.skip': {
          if (ops.length < 1 || ops.length > 2 || ops[0] === '') fail(`\`${name}\` の後ろにバイト数を書きます（例：${name} 16）`);
          const n = mustEv(ops[0], `\`${name}\` の大きさ`);
          const fill = ops.length === 2 ? mustEv(ops[1], '埋める値') : 0;
          if (!(n >= 0 && n <= SECTION_MAX) || !Number.isInteger(n)) fail(`\`${name}\` の大きさ ${n} は使えません（0〜${SECTION_MAX}）`);
          addItem({ line, size: n, emit: () => ({ bytes: fill ? new Array(n).fill(fill & 0xff) : null }) }, 1);
          return;
        }
        case '.align': case '.p2align': case '.balign': {
          if (ops.length < 1 || ops[0] === '') fail(`\`${name}\` の後ろに数を書きます（例：.align 2 で 4 バイト境界）`);
          const n = mustEv(ops[0], `\`${name}\` の数`);
          let bytes;
          if (name === '.balign') {
            if (!(n >= 1 && n <= 4096) || (n & (n - 1))) fail(`\`.balign\` の数は 2 のべき（1, 2, 4, 8 …）にします`);
            bytes = n;
          } else {
            if (!(n >= 0 && n <= 12) || !Number.isInteger(n)) fail(`\`${name} ${n}\` は使えません（${name} n は 2 の n 乗バイトに揃えます。n は 0〜12。4 バイト境界なら ${name} 2）`);
            bytes = 1 << n;
          }
          alignTo(bytes);
          return;
        }
        case '.equ': case '.set': case '.eqv': {
          if (ops.length !== 2 || !NAME_RE.test(ops[0])) fail(`\`${name}\` は「${name} 名前, 値」と書きます（例：.equ WIDTH, 32）`);
          defineConst(ops[0], ops[1], line);
          return;
        }
        default:
          if (name in IGNORED) return;
          if (name === '.macro' || name === '.endm' || name === '.rept' || name === '.endr' || name === '.include' || name === '.if')
            fail(`\`${name}\` には対応していません`);
          {
            const near = nearest(name, DIRECTIVES.concat(['.long', '.short', '.zero', '.set', '.section']));
            fail(`ディレクティブ \`${name}\` は使えません` + (near ? `。\`${near}\` のことですか？` : `（使えるのは ${DIRECTIVES.join(' ')}）`));
          }
      }
    }
    function defineConst(name, expr, line) {
      if (isRegName(name)) fail(`\`${name}\` はレジスタの名前なので、定数の名前には使えません`);
      if (name in symbols) fail(`\`${name}\` は ${symLine[name]} 行目でラベルとして定義されています`);
      consts[name] = mustEv(expr, `\`${name}\` の値`);
      symLine[name] = line;
    }
    function instruction(mn0, rest, line) {
      const mn = mn0.toLowerCase();
      const h = HANDLERS[mn];
      if (!h) {
        if (OTHER_ISA[mn]) fail(OTHER_ISA[mn]);
        if (mn === 'fence.i' || /^(c\.|f[a-z]+\.[sd]$|lr\.|sc\.|amo)/.test(mn)) fail(`命令 \`${mn0}\` には対応していません（使えるのは RV32I と M 拡張）`);
        const near = nearest(mn, MNEMONICS);
        fail(`命令 \`${mn0}\` はありません` + (near ? `。\`${near}\` のことですか？` : ''));
      }
      if (cur !== 'text') fail(`.data の中に命令 \`${mn}\` があります。命令の前の行に \`.text\` と書きます`);
      const ops = splitOperands(rest);
      if (h.counts.indexOf(ops.length) < 0 || ops.some((x) => x === '')) {
        const want = h.counts[0];
        let msg;
        if (ops.some((x) => x === '')) msg = `\`${mn}\` のカンマの前後に、書くものが抜けています（例：${h.ex}）`;
        else if (want === 0) msg = `\`${mn}\` の後ろには何も書きません`;
        else {
          msg = `\`${mn}\` には ${h.counts.join(' つか ')} つ書きます（例：${h.ex}）が、${ops.length} つ${ops.length < want ? 'しかありません' : 'あります'}`;
          if (ops.length < want && ops.some((x) => /\S\s+\S/.test(x) && !/[-+*\/&|^<>(]/.test(x))) msg += '。区切りにはカンマ `,` を書きます';
        }
        fail(msg);
      }
      let size = 4;
      if (mn === 'la') size = 8;
      else if (mn === 'li') {
        size = 8;
        if (ops.length === 2 && !isRegName(ops[1])) {
          const v = tryEv(ops[1]);
          if (v !== undefined) { const sv = v | 0; if ((sv >= -2048 && sv <= 2047) || (sv & 0xfff) === 0) size = 4; }
        }
      } else if (OP_MEM[OP[mn] || 0] && ops.length >= 2 && !memForm(ops[1]) && !isRegName(ops[1])) size = 8;
      addItem({
        line, size, ins: true, emit(c) {
          c.size = size;
          const words = h.fn(ops, c, mn);
          if (words.length * 4 !== size) fail(`\`${mn}\` の大きさが 1 回目と 2 回目で変わりました（.set で値を変えた名前を使っていませんか）`);
          return { words };
        },
      }, 4);
    }

    // ── 1 回目：行を読んで、大きさと番地を決める ──
    for (let li = 0; li < source.length; li++) {
      const line = li + 1;
      try {
        let text = stripComment(source[li]);
        const bare = text.replace(/"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])'/g, "''");
        const zen = /[\u3000\uff01-\uff5e]/.exec(bare);
        if (zen) {
          fail(zen[0] === '\u3000' ? '全角の空白が入っています。半角の空白に直します'
            : `全角の文字 \`${zen[0]}\` が入っています。半角の \`${String.fromCharCode(zen[0].charCodeAt(0) - 0xfee0)}\` に直します`);
        }
        text = text.trim();
        for (;;) {
          const m = /^([A-Za-z_.$][A-Za-z0-9_.$]*|\d+)\s*:/.exec(text);
          if (!m) break;
          if (isRegName(m[1])) fail(`\`${m[1]}\` はレジスタの名前なので、ラベルには使えません`);
          if (HANDLERS[m[1].toLowerCase()]) fail(`\`${m[1]}\` は命令の名前なので、ラベルには使えません`);
          pending.push({ name: m[1], line });
          text = text.slice(m[0].length).trim();
        }
        if (text === '') continue;
        let m = /^([A-Za-z_.$][A-Za-z0-9_.$]*)\s*=\s*(.+)$/.exec(text);
        if (m) { defineConst(m[1], m[2], line); continue; }
        m = /^(\S+)\s*([\s\S]*)$/.exec(text);
        if (m[1][0] === '.') directive(m[1].toLowerCase(), m[2], line);
        else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(m[1])) instruction(m[1], m[2], line);
        else if (/^[A-Za-z_][A-Za-z0-9_.]*,/.test(m[1])) fail(`\`${text}\` は命令として読めません（命令の名前の後ろは、カンマではなく空白です）`);
        else fail(`\`${m[1]}\` は命令として読めません。行は「ラベル: 命令 オペランド, …」の形で書きます`);
      } catch (e) {
        if (!(e instanceof AsmErr)) throw e;
        err(line, e.msg);
      }
    }
    flushLabels();
    for (const k of ['text', 'data']) {
      if (secs[k].size > SECTION_MAX) err(source.length, `.${k} が大きすぎます（${secs[k].size} バイト。上限は ${SECTION_MAX} バイト）`);
    }
    // 命令が 1 つでもあれば、.text の終わりを 4 の倍数に揃える
    secs.text.size = (secs.text.size + 3) & ~3;

    // ── 2 回目：機械語を作る ──
    const text = new Uint8Array(Math.min(secs.text.size, SECTION_MAX)), data = new Uint8Array(Math.min(secs.data.size, SECTION_MAX));
    const lineAt = Object.create(null), pcOfLine = Object.create(null);
    const allNames = () => Object.keys(symbols).concat(Object.keys(consts));
    if (!errors.some((e) => /大きすぎます/.test(e.msg))) {
      for (const it of items) {
        const lookup = lookupAt(it.index);
        const ev = (expr) => {
          try { return evalExpr(expr, lookup); }
          catch (e) {
            if (e instanceof AsmErr && e.undef && !isRegName(e.undef)) {
              const m = /^(\d+)([bf])$/.exec(e.undef);
              if (m) fail(`\`${e.undef}\` に当たるラベル \`${m[1]}:\` が${m[2] === 'b' ? '前' : '後ろ'}にありません`);
              const near = nearest(e.undef, allNames());
              fail(`ラベル \`${e.undef}\` が見つかりません` + (near ? `。\`${near}\` のことですか？` : '（`名前:` の形でどこかに定義します）'));
            }
            throw e;
          }
        };
        const c = {
          pc: it.addr, size: it.size, ev,
          reg(s) {
            const i = REG_INDEX[String(s).trim().toLowerCase()];
            if (i !== undefined) return i;
            const t = String(s).trim();
            if (/^[xX]\d+$/.test(t)) fail(`レジスタ名 \`${t}\` はありません（x0〜x31）`);
            if (/^-?(\d|0x)/.test(t) || t[0] === "'") fail(`ここにはレジスタを書きます（\`${t}\` は数です。数をレジスタに入れるには li を使います）`);
            if (memForm(t)) fail(`ここにはレジスタを書きます（\`${t}\` は番地の書き方です）`);
            const near = nearest(t, REG_NAMES);
            fail(`レジスタ名 \`${t}\` はありません` + (near && /^[a-z]+\d*$/i.test(t) ? `。\`${near}\` のことですか？` : '（x0〜x31、または zero ra sp gp tp t0〜t6 s0〜s11 a0〜a7）'));
          },
          imm12(s, mn) {
            if (isRegName(s)) fail(`ここには数を書きます（\`${s}\` はレジスタです）`);
            let v = ev(s);
            if (v >= 0xfffff800 && v <= 0xffffffff) v -= 0x100000000;
            if (!(v >= -2048 && v <= 2047)) {
              fail(`数 ${v} は \`${mn}\` に入りません（-2048〜2047 の 12 ビット）。` +
                (OP_MEM[OP[mn] || 0] ? '離れた番地は、先に `li` か `la` でレジスタに番地を入れます' : '大きな数は、先に `li` でレジスタに入れます'));
            }
            return v;
          },
          zimm(s) { const v = ev(s); if (!(v >= 0 && v <= 31)) fail(`ここに書ける数は 0〜31 です（${v} は入りません）`); return v; },
          csr(s) {
            const t = String(s).trim().toLowerCase();
            if (t in CSR_NAMES) return CSR_NAMES[t];
            if (/^(0x[0-9a-f]+|\d+)$/.test(t)) { const v = Number(t); if (v >= 0 && v <= 0xfff) return v; }
            const near = nearest(t, Object.keys(CSR_NAMES));
            fail(`CSR \`${s}\` はありません` + (near ? `。\`${near}\` のことですか？` : '（mstatus mtvec mepc mcause mtval mscratch など）'));
          },
          broff(s) {
            if (isRegName(s)) fail(`ここには飛び先のラベルを書きます（\`${s}\` はレジスタです）`);
            const off = (ev(s) - it.addr) | 0;
            if (off & 3) fail(`飛び先 0x${((it.addr + off) >>> 0).toString(16)} は 4 の倍数ではありません（命令は 4 バイトごとに並びます）`);
            if (off < -4096 || off > 4094) fail(`分岐先が遠すぎます（${off} バイト先。条件分岐は ±4096 バイトまで）。条件を逆にして近くへ分岐し、\`j\` で遠くへ飛びます`);
            return off;
          },
          jmpoff(s) {
            if (isRegName(s)) fail(`ここには飛び先のラベルを書きます（\`${s}\` はレジスタです）。レジスタの番地へ飛ぶなら \`jr\` か \`jalr\` です`);
            const off = (ev(s) - it.addr) | 0;
            if (off & 3) fail(`飛び先 0x${((it.addr + off) >>> 0).toString(16)} は 4 の倍数ではありません（命令は 4 バイトごとに並びます）`);
            if (off < -0x100000 || off > 0xffffe) fail(`飛び先が遠すぎます（${off} バイト先。jal は ±1 MiB まで）`);
            return off;
          },
        };
        try {
          const r = it.emit(c);
          const buf = it.sec === 'text' ? text : data, base = it.addr - secs[it.sec].base;
          if (r.words) {
            r.words.forEach((w, k) => {
              const o = base + 4 * k;
              buf[o] = w & 0xff; buf[o + 1] = (w >>> 8) & 0xff; buf[o + 2] = (w >>> 16) & 0xff; buf[o + 3] = w >>> 24;
              lineAt[it.addr + 4 * k] = it.line;
            });
            if (!(it.line in pcOfLine)) pcOfLine[it.line] = it.addr;
          } else {
            if (r.bytes) for (let k = 0; k < r.bytes.length; k++) buf[base + k] = r.bytes[k];
            for (let k = 0; k < it.size; k++) lineAt[it.addr + k] = it.line;
          }
        } catch (e) {
          if (!(e instanceof AsmErr)) throw e;
          err(it.line, e.msg);
        }
      }
    }
    errors.sort((a, b) => a.line - b.line);
    const ok = errors.length === 0;
    const words = new Uint32Array(ok ? text.length >> 2 : 0);
    if (ok) for (let i = 0; i < words.length; i++) words[i] = (text[4 * i] | (text[4 * i + 1] << 8) | (text[4 * i + 2] << 16) | (text[4 * i + 3] << 24)) >>> 0;
    const syms = {};
    for (const k in symbols) syms[k] = symbols[k];
    const cs = {};
    for (const k in consts) cs[k] = consts[k];
    const rev = reverseSymbols(syms);
    const prog = {
      ok, errors, errorText: errors.map((e) => e.text).join('\n'),
      words, text: ok ? text : new Uint8Array(0), data: ok ? data : new Uint8Array(0),
      textBase: 0, dataBase: DATA_BASE, textEnd: ok ? text.length : 0, dataEnd: DATA_BASE + (ok ? data.length : 0),
      entry: ok ? (syms._start !== undefined ? syms._start : syms.main !== undefined ? syms.main : 0) : 0,
      symbols: syms, consts: cs, source,
      lineOf: (pc) => lineAt[pc >>> 0] || lineAt[(pc >>> 0) & ~3] || 0,
      pcOf: (line) => (line in pcOfLine ? pcOfLine[line] : -1),
      labelAt: (addr) => (rev[addr >>> 0] !== undefined ? rev[addr >>> 0] : ''),
      listing: [],
    };
    if (ok) {
      for (let i = 0; i < words.length; i++) {
        const pc = 4 * i, line = lineAt[pc] || 0;
        prog.listing.push({ pc, word: words[i], line, asm: disasm(words[i], pc, { symbols: syms }), src: line ? source[line - 1] : '' });
      }
    }
    return prog;
  }

  function encode(line, pc) {
    pc = (pc >>> 0) || 0;
    if (pc & 3) throw new Error('pc は 4 の倍数にします');
    const pad = pc ? `.space ${pc}\n` : '';
    const p = assemble(pad + line);
    if (!p.ok) throw new Error(p.errors.map((e) => e.msg).join('\n'));
    return Array.from(p.words.subarray(pc >> 2));
  }

  // ───────── 乗算の上位 32 ビット ─────────
  function mulhu(a, b) {
    a >>>= 0; b >>>= 0;
    const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    return (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  }

  // ───────── パイプラインのモデル ─────────
  function pipeModel(cfg0, info) {
    const cfg = cfg0 === true || !cfg0 ? {} : cfg0;
    const fwd = cfg.forwarding !== false;
    const predictor = cfg.predictor === undefined || cfg.predictor === null ? 'none' : String(cfg.predictor);
    if (['none', 'taken', '1bit', '2bit'].indexOf(predictor) < 0) throw new Error(`pipeline.predictor に \`${predictor}\` は使えません（none / taken / 1bit / 2bit）`);
    const penalty = cfg.penalty === undefined ? 2 : cfg.penalty | 0;
    if (penalty < 0 || penalty > 8) throw new Error('pipeline.penalty は 0〜8 にします');
    let entries = cfg.entries === undefined ? 256 : cfg.entries | 0;
    if (entries < 1 || (entries & (entries - 1))) throw new Error('pipeline.entries は 2 のべきにします');
    const maxRows = cfg.rows === undefined ? 64 : cfg.rows | 0;
    const pmode = predictor === 'none' ? 0 : predictor === 'taken' ? 1 : predictor === '1bit' ? 2 : 3;

    let ready, rkind, table, nextF, prevD, lastWB, count, sLoad, sData, flush, pendFlush, branches, takenN, mispred, jumps, rows, real;
    function reset() {
      ready = new Float64Array(32); rkind = new Uint8Array(32);
      table = new Uint8Array(entries); if (pmode === 3) table.fill(1);
      nextF = 1; prevD = 0; lastWB = 0; count = 0; sLoad = 0; sData = 0; flush = 0; pendFlush = 0; branches = 0; takenN = 0; mispred = 0; jumps = 0;
      rows = []; real = 0;
    }
    reset();

    function hook(cur, op, rd, rs1, rs2, next) {
      const f = nextF;
      if (pendFlush) { flush += pendFlush; pendFlush = 0; }   // 捨てたサイクルは、次の命令が来たときに数える
      const idEntry = f + 1 > prevD + 1 ? f + 1 : prevD + 1;
      let d = idEntry, kind = 0, on = 0;
      if (OP_R1[op] && rs1 !== 0 && ready[rs1] > d) { d = ready[rs1]; kind = rkind[rs1]; on = rs1; }
      if (OP_R2[op] && rs2 !== 0 && ready[rs2] > d) { d = ready[rs2]; kind = rkind[rs2]; on = rs2; }
      const stall = d - idEntry;
      if (stall) { if (kind === 1) sLoad += stall; else sData += stall; }
      const e = d + 1;
      if (OP_W[op] && rd !== 0) {
        if (fwd) { if (OP_MEM[op] === 1) { ready[rd] = e + 1; rkind[rd] = 1; } else ready[rd] = 0; }
        else { ready[rd] = e + 2; rkind[rd] = 2; }
      }
      let mis = false, pred = false, taken = false;
      const ctl = OP_CTL[op];
      if (ctl === 1) {
        taken = next !== cur + 4;
        branches++; if (taken) takenN++;
        if (pmode === 1) pred = true;
        else if (pmode === 2) { const ix = (cur >>> 2) & (entries - 1); pred = table[ix] === 1; table[ix] = taken ? 1 : 0; }
        else if (pmode === 3) {
          const ix = (cur >>> 2) & (entries - 1), s = table[ix];
          pred = s >= 2;
          table[ix] = taken ? (s < 3 ? s + 1 : 3) : (s > 0 ? s - 1 : 0);
        }
        mis = pred !== taken;
        if (mis) mispred++;
      } else if (ctl === 2) { jumps++; taken = true; mis = penalty > 0; }
      if (mis && penalty > 0) { nextF = d + penalty; pendFlush = penalty; } else { nextF = idEntry; mis = mis && penalty > 0; }
      prevD = d; lastWB = e + 2;
      if (real < maxRows) {
        real++;
        const ii = info(cur);
        const cells = [];
        for (let c = f; c < idEntry; c++) cells.push({ c, s: 'IF', wait: c > f });
        for (let c = idEntry; c <= d; c++) cells.push({ c, s: 'ID', wait: c < d });
        cells.push({ c: e, s: 'EX', wait: false }, { c: e + 1, s: 'MEM', wait: false }, { c: e + 2, s: 'WB', wait: false });
        rows.push({
          n: count, pc: cur, word: ii.word, asm: ii.asm, line: ii.line, squashed: false, cells,
          stall, stallKind: stall ? (kind === 1 ? 'loadUse' : 'data') : null, stallReg: stall ? REG_NAMES[on] : null,
          mispredict: mis, predicted: ctl === 1 ? pred : null, taken: ctl ? taken : null,
        });
        if (mis) {
          // 捨てられる命令：予測した側の続き
          const wrong = ctl === 1 && pred ? ((cur + info(cur).imm) >>> 0) : cur + 4;
          const ST = ['ID', 'EX', 'MEM'];
          for (let k = 0; k < penalty; k++) {
            const wpc = (wrong + 4 * k) >>> 0, wi = info(wpc), wc = [];
            const f0 = k === 0 ? idEntry : d + k;
            const ifEnd = k === 0 ? d : f0;
            for (let c = f0; c <= ifEnd; c++) wc.push({ c, s: 'IF', wait: c > f0 });
            for (let c = ifEnd + 1, q = 0; c <= d + penalty - 1 && q < 3; c++, q++) wc.push({ c, s: ST[q], wait: false });
            rows.push({
              n: null, pc: wpc, word: wi.word, asm: wi.asm, line: wi.line, squashed: true, cells: wc,
              stall: 0, stallKind: null, stallReg: null, mispredict: false, predicted: null, taken: null,
            });
          }
        }
      }
      count++;
    }
    return {
      hook, reset,
      get rows() { return rows; },
      get stats() {
        const cycles = count ? lastWB : 0;
        return {
          instructions: count, cycles, cpi: count ? cycles / count : 0,
          stalls: { loadUse: sLoad, data: sData, total: sLoad + sData }, flushCycles: flush,
          branches, taken: takenN, mispredicts: mispred, accuracy: branches ? (branches - mispred) / branches : 1, jumps,
          forwarding: fwd, predictor, penalty,
        };
      },
      save: () => ({ ready: ready.slice(), rkind: rkind.slice(), table: table.slice(), nextF, prevD, lastWB, count, sLoad, sData, flush, pendFlush, branches, takenN, mispred, jumps, rows: rows.slice(), real }),
      load(s) {
        ready = s.ready.slice(); rkind = s.rkind.slice(); table = s.table.slice();
        nextF = s.nextF; prevD = s.prevD; lastWB = s.lastWB; count = s.count; sLoad = s.sLoad; sData = s.sData; flush = s.flush; pendFlush = s.pendFlush;
        branches = s.branches; takenN = s.takenN; mispred = s.mispred; jumps = s.jumps; rows = s.rows.slice(); real = s.real;
      },
    };
  }

  // ───────── キャッシュのモデル ─────────
  const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  const log2 = (n) => 31 - Math.clz32(n);
  function cacheModel(cfg0) {
    let cfg = cfg0;
    if (cfg === true) cfg = {};
    if (typeof cfg === 'string') {
      const p = cfg.split(',').map((x) => Number(x.trim()));
      cfg = { size: p[0], block: p[1], ways: p[2] === undefined ? 1 : p[2] };
      if (p.length > 3) cfg.missPenalty = p[3];
    }
    const size = cfg.size === undefined ? 256 : cfg.size, block = cfg.block === undefined ? 16 : cfg.block, ways = cfg.ways === undefined ? 1 : cfg.ways;
    const missPenalty = cfg.missPenalty === undefined ? 10 : cfg.missPenalty;
    const maxHist = cfg.history === undefined ? 2000 : cfg.history;
    if (!isPow2(size) || !isPow2(block) || !isPow2(ways)) throw new Error(`キャッシュの容量・ブロック・連想度は 2 のべきにします（容量 ${size}、ブロック ${block}、連想度 ${ways}）`);
    if (block < 4) throw new Error('キャッシュのブロックは 4 バイト以上にします');
    if (block * ways > size) throw new Error(`キャッシュの容量 ${size} バイトに、${block} バイトのブロックは ${ways} 個入りません`);
    const sets = size / (block * ways), offBits = log2(block), setBits = log2(sets);
    let tags, age, tick, hits, misses, reads, writes, rMiss, wMiss, history;
    function reset() {
      tags = new Int32Array(sets * ways).fill(-1); age = new Float64Array(sets * ways);
      tick = 0; hits = 0; misses = 0; reads = 0; writes = 0; rMiss = 0; wMiss = 0; history = [];
    }
    reset();
    function access(addr, write, width, pc, n) {
      const blk = addr >>> offBits, set = blk & (sets - 1), tag = blk >>> setBits, base = set * ways;
      let way = -1, hit = false, evicted = null;
      for (let w = 0; w < ways; w++) if (tags[base + w] === tag) { way = w; hit = true; break; }
      if (!hit) {
        let oldest = Infinity;
        for (let w = 0; w < ways; w++) {
          if (tags[base + w] === -1) { way = w; oldest = -1; break; }
          if (age[base + w] < oldest) { oldest = age[base + w]; way = w; }
        }
        if (tags[base + way] !== -1) evicted = (((tags[base + way] << setBits) | set) << offBits) >>> 0;
        tags[base + way] = tag;
        misses++; if (write) wMiss++; else rMiss++;
      } else hits++;
      if (write) writes++; else reads++;
      age[base + way] = ++tick;
      if (history.length < maxHist) history.push({ n, pc, addr, write, width, block: (blk << offBits) >>> 0, set, tag, way, hit, evicted });
    }
    return {
      access, reset,
      get history() { return history; },
      get stats() {
        const accesses = hits + misses;
        return {
          accesses, hits, misses, hitRate: accesses ? hits / accesses : 0, reads, writes, readMisses: rMiss, writeMisses: wMiss,
          missPenalty, penalty: misses * missPenalty, size, block, ways, sets,
        };
      },
      lines() {
        const out = [];
        for (let s = 0; s < sets; s++) {
          const ws = [];
          for (let w = 0; w < ways; w++) {
            const t = tags[s * ways + w];
            ws.push({ way: w, valid: t !== -1, tag: t === -1 ? null : t, addr: t === -1 ? null : (((t << setBits) | s) << offBits) >>> 0, age: age[s * ways + w] });
          }
          out.push({ set: s, ways: ws });
        }
        return out;
      },
      save: () => ({ tags: tags.slice(), age: age.slice(), tick, hits, misses, reads, writes, rMiss, wMiss, history: history.slice() }),
      load(s) {
        tags = s.tags.slice(); age = s.age.slice(); tick = s.tick; hits = s.hits; misses = s.misses; reads = s.reads; writes = s.writes;
        rMiss = s.rMiss; wMiss = s.wMiss; history = s.history.slice();
      },
    };
  }

  // ───────── 機械 ─────────
  function Trap(cause, tval, detail) { this.cause = cause; this.tval = tval >>> 0; this.detail = detail || ''; }
  const R_LIMIT = 1, R_END = 2, R_EXIT = 3, R_FRAME = 4, R_BREAK = 5;
  const DEFAULT_SEED = 0x2545f491;
  const MSTATUS_MIE = 8, MSTATUS_MPIE = 0x80, MSTATUS_MPP = 0x1800;
  const KEY_CODES = { ArrowLeft: 1, ArrowUp: 2, ArrowRight: 3, ArrowDown: 4, Enter: 10, Backspace: 8, Tab: 9, Escape: 27, Delete: 127, Spacebar: 32 };
  const keyCode = (key) => {
    if (typeof key === 'number') return key & 0xff;
    key = String(key);
    if (key in KEY_CODES) return KEY_CODES[key];
    if (key.length === 1 && key.charCodeAt(0) < 128) return key.charCodeAt(0);
    return 0;
  };
  const WIDTH_WORD = { 1: 'バイト', 2: '2 バイト', 4: '4 バイト' };

  function machine(opts) {
    opts = opts || {};
    const maxSteps = opts.maxSteps > 0 ? Math.floor(opts.maxSteps) : 1000000;
    const seed0 = (opts.seed === undefined || opts.seed === null || (opts.seed >>> 0) === 0) ? DEFAULT_SEED : opts.seed >>> 0;
    const mem = new Uint8Array(RAM_SIZE), screen = new Uint8Array(SCREEN_SIZE), regs = new Int32Array(32);
    const NW = RAM_SIZE >> 2;
    const dOp = new Uint8Array(NW), dRd = new Uint8Array(NW), dRs1 = new Uint8Array(NW), dRs2 = new Uint8Array(NW), dImm = new Int32Array(NW);
    let opCount = new Float64Array(NOPS + 2);
    let pc = 0, steps = 0, textEnd = 0, prog = null, halted = null;
    let out = '', u8need = 0, u8cp = 0;
    let rng = seed0, keys = [], held = 0, frames = 0, screenUsed = false;
    let priv = 3;
    const csr = { mstatus: 0, mtvec: 0, mepc: 0, mcause: 0, mtval: 0, mscratch: 0, mie: 0, mip: 0 };
    let stop = 0, frameStop = false, lastAddr = 0, ioLog = null, lastTrap = null, branchN = 0, takenN = 0;
    let pipe = null, cache = null, hooks = false;

    const symbols = () => (prog ? prog.symbols : null);
    const lineOf = (a) => (prog ? prog.lineOf(a) : 0);
    const word32 = (a) => (mem[a] | (mem[a + 1] << 8) | (mem[a + 2] << 16) | (mem[a + 3] << 24)) >>> 0;
    function insnInfo(a) {
      a >>>= 0;
      if (a > RAM_SIZE - 4 || (a & 3)) return { word: 0, asm: '', line: 0, imm: 0 };
      const w = word32(a);
      return { word: w, asm: disasm(w, a, { symbols: symbols() }), line: lineOf(a), imm: dec(w).imm };
    }
    if (opts.pipeline) pipe = pipeModel(opts.pipeline, insnInfo);
    if (opts.cache) cache = cacheModel(opts.cache);
    hooks = !!(pipe || cache);

    function decodeAt(i) {
      const d = dec(word32(i << 2));
      const op = d.op || OP_ILLEGAL;
      dOp[i] = op; dRd[i] = d.rd; dRs1[i] = d.rs1; dRs2[i] = d.rs2; dImm[i] = d.imm;
      return op;
    }

    // ── コンソール ──
    function emit(text, byte) {
      out += text;
      if (ioLog) {
        const last = ioLog[ioLog.length - 1];
        if (last && last.type === 'console') last.text += text; else ioLog.push({ type: 'console', text });
      }
    }
    function putByte(b) {
      if (u8need > 0) {
        if ((b & 0xc0) === 0x80) {
          u8cp = (u8cp << 6) | (b & 0x3f);
          if (--u8need === 0) emit(u8cp > 0x10ffff || (u8cp >= 0xd800 && u8cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(u8cp));
          return;
        }
        u8need = 0; emit('\ufffd');
      }
      if (b < 0x80) emit(String.fromCharCode(b));
      else if (b >= 0xc2 && b <= 0xdf) { u8need = 1; u8cp = b & 0x1f; }
      else if (b >= 0xe0 && b <= 0xef) { u8need = 2; u8cp = b & 0x0f; }
      else if (b >= 0xf0 && b <= 0xf4) { u8need = 3; u8cp = b & 0x07; }
      else emit('\ufffd');
    }
    function print(text) {
      if (u8need > 0) { u8need = 0; emit('\ufffd'); }
      emit(text);
    }
    function random() {
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0;
      return rng;
    }

    const RANGE = 'RAM は 0x0000〜0xFFFF、画面は 0x10000〜0x103FF、入出力は 0x20000〜0x20014';
    function badAddr(a, w, write, name) {
      const hint = a < 0x100 && !write ? '。レジスタに番地を入れ忘れていませんか' : '';
      return new Trap(write ? 7 : 5, a, `番地 ${h0x(a)} にはメモリも入出力もないので、${name} で${write ? '書けません' : '読めません'}（${RANGE}）${hint}`);
    }
    function ioRead(a, w, sgn, name) {
      if (w > 1 && (a & (w - 1))) {
        throw new Trap(4, a, `番地 ${h0x(a)} は ${w} の倍数ではないので ${name} で読めません（${name} は ${w} バイトをまとめて読むので、番地を ${w} の倍数にします）`);
      }
      let v;
      if (a >= SCREEN_BASE && a + w <= SCREEN_BASE + SCREEN_SIZE) {
        const o = a - SCREEN_BASE;
        v = screen[o];
        if (w > 1) v |= screen[o + 1] << 8;
        if (w > 2) v |= (screen[o + 2] << 16) | (screen[o + 3] << 24);
      } else {
        switch (a) {
          case IO_CONSOLE: v = 0; break;
          case IO_KEY: v = keys.length ? keys.shift() : 0; if (ioLog) ioLog.push({ type: 'key', code: v }); break;
          case IO_RANDOM: v = random(); if (ioLog) ioLog.push({ type: 'random', value: v }); break;
          case IO_CYCLE: v = steps >>> 0; if (ioLog) ioLog.push({ type: 'cycle', value: v }); break;
          case IO_FRAME: v = frames >>> 0; break;
          case IO_KEYS: v = held; break;
          default: throw badAddr(a, w, false, name);
        }
      }
      return w === 4 ? v | 0 : w === 2 ? (sgn ? (v << 16) >> 16 : v & 0xffff) : (sgn ? (v << 24) >> 24 : v & 0xff);
    }
    function ioWrite(a, w, v, name) {
      if (w > 1 && (a & (w - 1))) {
        throw new Trap(6, a, `番地 ${h0x(a)} は ${w} の倍数ではないので ${name} で書けません（${name} は ${w} バイトをまとめて書くので、番地を ${w} の倍数にします）`);
      }
      if (a >= SCREEN_BASE && a + w <= SCREEN_BASE + SCREEN_SIZE) {
        const o = a - SCREEN_BASE;
        screenUsed = true;
        for (let k = 0; k < w; k++) {
          const c = (v >>> (8 * k)) & 15;
          screen[o + k] = c;
          if (ioLog) ioLog.push({ type: 'screen', addr: a + k, x: (o + k) & 31, y: (o + k) >> 5, color: c });
        }
        return;
      }
      switch (a) {
        case IO_CONSOLE: putByte(v & 0xff); return;
        case IO_KEY: keys = []; return;
        case IO_RANDOM: rng = (v >>> 0) || DEFAULT_SEED; return;
        case IO_CYCLE: case IO_KEYS: return;
        case IO_FRAME:
          frames++; screenUsed = true;
          if (ioLog) ioLog.push({ type: 'frame' });
          if (frameStop) stop = R_FRAME;
          return;
        default: throw badAddr(a, w, true, name);
      }
    }

    // ── CSR ──
    function illegal(detail) { return new Trap(2, word32(pc), detail); }
    function csrRead(num) {
      switch (num) {
        case 0x300: return csr.mstatus; case 0x301: return 0x40001100; case 0x304: return csr.mie; case 0x305: return csr.mtvec;
        case 0x340: return csr.mscratch; case 0x341: return csr.mepc; case 0x342: return csr.mcause; case 0x343: return csr.mtval; case 0x344: return csr.mip;
        case 0xb00: case 0xb02: case 0xc00: case 0xc01: case 0xc02: return steps | 0;
        case 0xf11: case 0xf12: case 0xf13: case 0xf14: return 0;
      }
      throw illegal(`CSR 0x${num.toString(16)} はありません（使えるのは mstatus mtvec mepc mcause mtval mscratch mie mip など）`);
    }
    function csrWrite(num, v) {
      switch (num) {
        case 0x300: csr.mstatus = (v & (MSTATUS_MIE | MSTATUS_MPIE)) | (((v >>> 11) & 3) === 3 ? MSTATUS_MPP : 0); return;
        case 0x304: csr.mie = v | 0; return; case 0x305: csr.mtvec = v & ~3; return;
        case 0x340: csr.mscratch = v | 0; return; case 0x341: csr.mepc = v & ~3; return; case 0x342: csr.mcause = v | 0; return;
        case 0x343: csr.mtval = v | 0; return; case 0x344: csr.mip = v | 0; return;
        case 0x301: case 0xb00: case 0xb02: return;
      }
    }
    function csrOp(op, rd, rs1, num) {
      if (priv !== 3) throw illegal('U モードでは CSR を読み書きできません（M モードだけができます）');
      const src = op >= O.csrrwi ? rs1 : regs[rs1];
      const kind = (op - O.csrrw) % 3;
      const old = csrRead(num);
      if (kind === 0 || rs1 !== 0) {
        if ((num >>> 10) === 3) throw illegal(`CSR ${CSR_BY_NUM[num] || '0x' + num.toString(16)} は読み出し専用なので書けません`);
        csrWrite(num, kind === 0 ? src : kind === 1 ? old | src : old & ~src);
      }
      regs[rd] = old;
    }

    // ── ecall ──
    function ecall() {
      if (priv === 0 && csr.mtvec !== 0) throw new Trap(8, 0, '');
      const n = regs[17], a0 = regs[10];
      switch (n) {
        case 1: print(String(a0)); return;
        case 4: {
          let a = a0 >>> 0;
          if (u8need > 0) { u8need = 0; emit('\ufffd'); }
          for (;;) {
            if (a >= RAM_SIZE) {
              throw new Trap(5, a, `ecall 4（文字列の表示）で読もうとした番地 ${h0x(a)} は RAM の外です。a0 に文字列の番地を入れたか、文字列が 0（NUL）で終わっているかを確かめます`);
            }
            const b = mem[a++];
            if (b === 0) break;
            putByte(b);
          }
          if (u8need > 0) { u8need = 0; emit('\ufffd'); }
          return;
        }
        case 11: {
          const c = a0 >>> 0;
          print(c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : '\ufffd');
          return;
        }
        case 34: print(h0x(a0)); return;
        case 35: print((a0 >>> 0).toString(2).padStart(32, '0')); return;
        case 36: print(String(a0 >>> 0)); return;
        case 10: case 93:
          halted = { reason: 'exit', exitCode: n === 93 ? a0 : 0 };
          if (ioLog) ioLog.push({ type: 'exit', code: halted.exitCode });
          stop = R_EXIT;
          return;
      }
      throw new Trap(11, n, `a7 = ${n} の ecall はありません（使えるのは 1, 4, 10, 11, 34, 35, 36, 93）。ecall の前に a7 へ番号を入れます`);
    }

    function timing(cur, op, rd, rs1, rs2, next) {
      if (pipe) pipe.hook(cur, op, rd, rs1, rs2, next);
      if (cache && OP_MEM[op] && lastAddr < RAM_SIZE) cache.access(lastAddr, OP_MEM[op] === 2, OP_WIDTH[op], cur, steps - 1);
    }

    // ── 実行の中心 ──
    function loop(max) {
      let n = 0;
      while (n < max) {
        const cur = pc;
        if (cur === textEnd) return R_END;
        if (cur >= RAM_SIZE || (cur & 3)) throw new Trap(cur & 3 ? 0 : 1, cur, '');
        const i = cur >>> 2;
        let op = dOp[i];
        if (op === 0) op = decodeAt(i);
        const rd = dRd[i], rs1 = dRs1[i], rs2 = dRs2[i], imm = dImm[i];
        let next = cur + 4;
        switch (op) {
          case 1: regs[rd] = imm; break;                                    // lui
          case 2: regs[rd] = cur + imm; break;                              // auipc
          case 3: regs[rd] = cur + 4; next = (cur + imm) >>> 0; break;      // jal
          case 4: { const t = (regs[rs1] + imm) & -2; regs[rd] = cur + 4; next = t >>> 0; break; }   // jalr
          case 5: branchN++; if (regs[rs1] === regs[rs2]) { next = (cur + imm) >>> 0; takenN++; } break;
          case 6: branchN++; if (regs[rs1] !== regs[rs2]) { next = (cur + imm) >>> 0; takenN++; } break;
          case 7: branchN++; if (regs[rs1] < regs[rs2]) { next = (cur + imm) >>> 0; takenN++; } break;
          case 8: branchN++; if (regs[rs1] >= regs[rs2]) { next = (cur + imm) >>> 0; takenN++; } break;
          case 9: branchN++; if ((regs[rs1] >>> 0) < (regs[rs2] >>> 0)) { next = (cur + imm) >>> 0; takenN++; } break;
          case 10: branchN++; if ((regs[rs1] >>> 0) >= (regs[rs2] >>> 0)) { next = (cur + imm) >>> 0; takenN++; } break;
          case 11: { const a = (regs[rs1] + imm) >>> 0; lastAddr = a; regs[rd] = a < RAM_SIZE ? (mem[a] << 24) >> 24 : ioRead(a, 1, true, 'lb'); break; }
          case 12: {
            const a = (regs[rs1] + imm) >>> 0; lastAddr = a;
            regs[rd] = (a < RAM_SIZE - 1 && !(a & 1)) ? ((mem[a] | (mem[a + 1] << 8)) << 16) >> 16 : ioRead(a, 2, true, 'lh');
            break;
          }
          case 13: {
            const a = (regs[rs1] + imm) >>> 0; lastAddr = a;
            regs[rd] = (a < RAM_SIZE - 3 && !(a & 3)) ? mem[a] | (mem[a + 1] << 8) | (mem[a + 2] << 16) | (mem[a + 3] << 24) : ioRead(a, 4, true, 'lw');
            break;
          }
          case 14: { const a = (regs[rs1] + imm) >>> 0; lastAddr = a; regs[rd] = a < RAM_SIZE ? mem[a] : ioRead(a, 1, false, 'lbu'); break; }
          case 15: {
            const a = (regs[rs1] + imm) >>> 0; lastAddr = a;
            regs[rd] = (a < RAM_SIZE - 1 && !(a & 1)) ? mem[a] | (mem[a + 1] << 8) : ioRead(a, 2, false, 'lhu');
            break;
          }
          case 16: {
            const a = (regs[rs1] + imm) >>> 0; lastAddr = a;
            if (a < RAM_SIZE) { mem[a] = regs[rs2]; dOp[a >>> 2] = 0; } else ioWrite(a, 1, regs[rs2], 'sb');
            break;
          }
          case 17: {
            const a = (regs[rs1] + imm) >>> 0, v = regs[rs2]; lastAddr = a;
            if (a < RAM_SIZE - 1 && !(a & 1)) { mem[a] = v; mem[a + 1] = v >> 8; dOp[a >>> 2] = 0; } else ioWrite(a, 2, v, 'sh');
            break;
          }
          case 18: {
            const a = (regs[rs1] + imm) >>> 0, v = regs[rs2]; lastAddr = a;
            if (a < RAM_SIZE - 3 && !(a & 3)) { mem[a] = v; mem[a + 1] = v >> 8; mem[a + 2] = v >> 16; mem[a + 3] = v >> 24; dOp[a >>> 2] = 0; }
            else ioWrite(a, 4, v, 'sw');
            break;
          }
          case 19: regs[rd] = regs[rs1] + imm; break;
          case 20: regs[rd] = regs[rs1] < imm ? 1 : 0; break;
          case 21: regs[rd] = (regs[rs1] >>> 0) < (imm >>> 0) ? 1 : 0; break;
          case 22: regs[rd] = regs[rs1] ^ imm; break;
          case 23: regs[rd] = regs[rs1] | imm; break;
          case 24: regs[rd] = regs[rs1] & imm; break;
          case 25: regs[rd] = regs[rs1] << imm; break;
          case 26: regs[rd] = regs[rs1] >>> imm; break;
          case 27: regs[rd] = regs[rs1] >> imm; break;
          case 28: regs[rd] = regs[rs1] + regs[rs2]; break;
          case 29: regs[rd] = regs[rs1] - regs[rs2]; break;
          case 30: regs[rd] = regs[rs1] << (regs[rs2] & 31); break;
          case 31: regs[rd] = regs[rs1] < regs[rs2] ? 1 : 0; break;
          case 32: regs[rd] = (regs[rs1] >>> 0) < (regs[rs2] >>> 0) ? 1 : 0; break;
          case 33: regs[rd] = regs[rs1] ^ regs[rs2]; break;
          case 34: regs[rd] = regs[rs1] >>> (regs[rs2] & 31); break;
          case 35: regs[rd] = regs[rs1] >> (regs[rs2] & 31); break;
          case 36: regs[rd] = regs[rs1] | regs[rs2]; break;
          case 37: regs[rd] = regs[rs1] & regs[rs2]; break;
          case 38: regs[rd] = Math.imul(regs[rs1], regs[rs2]); break;
          case 39: { const a = regs[rs1], b = regs[rs2]; regs[rd] = mulhu(a, b) - (a < 0 ? b >>> 0 : 0) - (b < 0 ? a >>> 0 : 0); break; }
          case 40: { const a = regs[rs1], b = regs[rs2]; regs[rd] = mulhu(a, b) - (a < 0 ? b >>> 0 : 0); break; }
          case 41: regs[rd] = mulhu(regs[rs1], regs[rs2]); break;
          case 42: { const a = regs[rs1], b = regs[rs2]; regs[rd] = b === 0 ? -1 : (a === -2147483648 && b === -1) ? a : (a / b) | 0; break; }
          case 43: { const a = regs[rs1] >>> 0, b = regs[rs2] >>> 0; regs[rd] = b === 0 ? -1 : Math.floor(a / b); break; }
          case 44: { const a = regs[rs1], b = regs[rs2]; regs[rd] = b === 0 ? a : (a === -2147483648 && b === -1) ? 0 : a % b; break; }
          case 45: { const a = regs[rs1] >>> 0, b = regs[rs2] >>> 0; regs[rd] = b === 0 ? a : a % b; break; }
          case 46: break;                                                    // fence
          case 47: ecall(); break;
          case 48: if (csr.mtvec !== 0) throw new Trap(3, cur, ''); stop = R_BREAK; break;
          case 49: {                                                         // mret
            if (priv !== 3) throw illegal('U モードでは mret を実行できません');
            next = csr.mepc >>> 0;
            priv = (csr.mstatus & MSTATUS_MPP) ? 3 : 0;
            csr.mstatus = (csr.mstatus & MSTATUS_MPIE ? MSTATUS_MIE : 0) | MSTATUS_MPIE;
            break;
          }
          case 50: break;                                                    // wfi
          case 51: case 52: case 53: case 54: case 55: case 56: csrOp(op, rd, rs1, imm); break;
          default: {
            const w = word32(cur);
            throw new Trap(2, w, `機械語 ${h0x(w)} は命令として解釈できません` +
              (w === 0 ? '（何も置いていない場所を実行しています。飛び先が正しいか確かめます）' : '（データを命令として実行していませんか）'));
          }
        }
        if (next & 3) {
          throw new Trap(0, next, `飛び先 ${h0x(next)} は 4 の倍数ではありません（命令は 4 バイトごとに並びます）`);
        }
        regs[0] = 0;
        pc = next; n++; steps++; opCount[op]++;
        if (hooks) timing(cur, op, rd, rs1, rs2, next);
        if (stop !== 0) { const s = stop; stop = 0; return s; }
      }
      return R_LIMIT;
    }

    function describe(t) {
      const at = pc >>> 0;
      const line = lineOf(at);
      let detail = t.detail, asm = '';
      if (t.cause === 0 && !detail) detail = `pc が ${h0x(at)} になりました。4 の倍数ではないので、命令として読めません`;
      else if (t.cause === 1) {
        detail = `pc が ${h0x(at)} になりました。そこは RAM（0x0000〜0xFFFF）の外なので、命令を読めません` +
          '（ra を壊したまま ret した、番地ではない値に jr / jalr した、などが原因です）';
      }
      let msg;
      if (t.cause === 1 || (t.cause === 0 && !t.detail)) msg = detail;
      else {
        asm = insnInfo(at).asm;
        msg = `${h0x(at)} 番地の \`${asm}\`${line ? `（${line} 行目）` : ''}：${detail}`;
      }
      return { msg, detail, pc: at, line, asm, cause: t.cause, causeName: CAUSES[t.cause] || '', tval: t.tval };
    }
    function deliver(t) {
      const handler = csr.mtvec >>> 0;
      lastTrap = { cause: t.cause, causeName: CAUSES[t.cause] || '', tval: t.tval, handler };
      csr.mepc = pc | 0; csr.mcause = t.cause; csr.mtval = t.tval | 0;
      csr.mstatus = (csr.mstatus & MSTATUS_MIE ? MSTATUS_MPIE : 0) | (priv === 3 ? MSTATUS_MPP : 0);
      priv = 3;
      pc = handler;
    }
    const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    function result(reason, ran) {
      const r = { reason, exitCode: null, error: null, message: '', steps, ran };
      if (reason === 'exit') { r.exitCode = halted.exitCode; r.message = `終了しました（終了コード ${r.exitCode}）`; }
      else if (reason === 'end') r.message = 'プログラムの最後まで実行しました';
      else if (reason === 'frame') r.message = '1 フレーム描きました';
      else if (reason === 'break') r.message = `ebreak で止まりました（次は ${h0x(pc)} 番地）`;
      else if (reason === 'limit') r.message = `${fmtN(ran)} 命令を実行しても止まらないので打ち切りました（無限ループになっていませんか）`;
      else if (reason === 'error') { r.error = halted.error; r.message = halted.error.msg; }
      return r;
    }
    function exec(max, untilFrame) {
      if (!prog) throw new Error('プログラムが読み込まれていません。先に m.load(prog) を呼びます');
      if (halted) return result(halted.reason, 0);
      frameStop = untilFrame; stop = 0;
      const start = steps;
      let code = R_LIMIT;
      for (;;) {
        const left = max - (steps - start);
        if (left <= 0) { code = R_LIMIT; break; }
        try { code = loop(left); break; }
        catch (e) {
          if (!(e instanceof Trap)) throw e;
          regs[0] = 0;
          if (csr.mtvec !== 0) { deliver(e); steps++; continue; }
          halted = { reason: 'error', error: describe(e) };
          return result('error', steps - start);
        }
      }
      const ran = steps - start;
      if (code === R_EXIT) return result('exit', ran);
      if (code === R_FRAME) return result('frame', ran);
      if (code === R_BREAK) return result('break', ran);
      if (code === R_END || pc === textEnd) { halted = { reason: 'end' }; return result('end', ran); }
      return result('limit', ran);
    }

    function peek(a, w) {
      a >>>= 0;
      let v = 0;
      if (a + w <= RAM_SIZE) { for (let k = 0; k < w; k++) v |= mem[a + k] << (8 * k); return v >>> 0; }
      if (a >= SCREEN_BASE && a + w <= SCREEN_BASE + SCREEN_SIZE) { for (let k = 0; k < w; k++) v |= screen[a - SCREEN_BASE + k] << (8 * k); return v >>> 0; }
      return null;
    }
    function poke(a, w, v) {
      a >>>= 0;
      for (let k = 0; k < w; k++) {
        const b = (v >>> (8 * k)) & 0xff, x = a + k;
        if (x < RAM_SIZE) { mem[x] = b; dOp[x >>> 2] = 0; }
        else if (x >= SCREEN_BASE && x < SCREEN_BASE + SCREEN_SIZE) screen[x - SCREEN_BASE] = b & 15;
        else throw new Error(`番地 ${h0x(x)} には書けません（${RANGE}）`);
      }
    }
    const region = (a) => (a < RAM_SIZE ? 'ram' : a >= SCREEN_BASE && a < SCREEN_BASE + SCREEN_SIZE ? 'screen' : 'io');
    const maskW = (v, w) => (w === 4 ? v >>> 0 : w === 2 ? v & 0xffff : v & 0xff);

    function step() {
      if (!prog) throw new Error('プログラムが読み込まれていません。先に m.load(prog) を呼びます');
      if (halted || pc === textEnd) {
        const r = exec(1, false);
        return { done: true, reason: r.reason, result: r, error: r.error, pc: pc >>> 0, nextPc: pc >>> 0, reads: [], writes: [], mem: [], io: [], branch: null, trap: null };
      }
      const cur = pc >>> 0;
      const fetchable = cur < RAM_SIZE && !(cur & 3);
      const w = fetchable ? word32(cur) : 0;
      const d = fetchable ? dec(w) : { op: 0, rd: 0, rs1: 0, rs2: 0, imm: 0 };
      const op = d.op, name = op ? OP_NAME[op] : null, cls = op ? OP_CLS[op] : null;
      const info = {
        done: false, reason: null, result: null, error: null,
        pc: cur, word: w, asm: fetchable ? disasm(w, cur, { symbols: symbols() }) : '', line: lineOf(cur), name, cls, format: op ? OP_FMT[op] : null,
        reads: [], writes: [], mem: [], nextPc: cur, branch: null, io: [], trap: null, alu: null, control: null,
      };
      const rv = (r) => ({ reg: r, name: REG_NAMES[r], value: regs[r] });
      let a = 0, b = 0, addr = 0, memRec = null;
      if (op) {
        if (OP_R1[op]) info.reads.push(rv(d.rs1));
        if (OP_R2[op]) info.reads.push(rv(d.rs2));
        if (op === O.ecall) { info.reads.push(rv(17)); if (regs[17] !== 10) info.reads.push(rv(10)); }
        const fmt = OP_FMT[op];
        a = op === O.auipc || op === O.jal ? cur : OP_R1[op] ? regs[d.rs1] : 0;
        b = fmt === 'R' || fmt === 'B' ? regs[d.rs2] : op >= O.csrrw ? 0 : d.imm;
        if (OP_MEM[op]) {
          addr = (regs[d.rs1] + d.imm) >>> 0;
          const width = OP_WIDTH[op];
          memRec = { rw: OP_MEM[op] === 1 ? 'r' : 'w', addr, width, value: null, before: null, region: region(addr) };
          if (OP_MEM[op] === 1) memRec.value = peek(addr, width);
          else { memRec.before = peek(addr, width); memRec.value = maskW(regs[d.rs2], width); }
        }
        info.control = {
          regWrite: !!OP_W[op], aluSrc: fmt === 'R' || fmt === 'B' ? 'rs2' : 'imm', memRead: OP_MEM[op] === 1, memWrite: OP_MEM[op] === 2,
          memToReg: OP_MEM[op] === 1, branch: cls === 'branch', jump: cls === 'jump',
        };
      }
      const before = op && OP_W[op] ? regs[d.rd] : 0;
      ioLog = info.io; lastTrap = null;
      let r;
      try { r = exec(1, false); } finally { ioLog = null; }
      info.nextPc = pc >>> 0;
      info.trap = lastTrap;
      const failed = r.reason === 'error' || lastTrap;
      if (op && !failed) {
        if (OP_W[op] && d.rd !== 0) info.writes.push({ reg: d.rd, name: REG_NAMES[d.rd], before, after: regs[d.rd] });
        if (memRec) {
          if (memRec.rw === 'r' && memRec.value === null) memRec.value = maskW(regs[d.rd], memRec.width);
          info.mem.push(memRec);
        }
        if (cls === 'branch') info.branch = { taken: info.nextPc !== cur + 4, target: (cur + d.imm) >>> 0 };
        else if (cls === 'jump') info.branch = { taken: true, target: info.nextPc };
        let res;
        if (cls === 'branch') res = info.branch.taken ? 1 : 0;
        else if (cls === 'load' || cls === 'store') res = addr | 0;
        else if (cls === 'jump') res = info.nextPc | 0;
        else if (cls === 'system') res = null;
        else res = regs[d.rd] | 0;
        if (d.rd === 0 && (cls === 'arith' || cls === 'muldiv')) res = null;
        info.alu = cls === 'system' ? null : { a, b, op: OP_ALU[op], result: res };
      }
      if (r.reason !== 'limit') { info.reason = r.reason; info.result = r; info.error = r.error; }
      return info;
    }

    function load(p) {
      if (!p || !p.ok) {
        throw new Error(p && p.errors && p.errors.length ? 'アセンブルエラーのあるプログラムは読み込めません：' + p.errors[0].text : 'RV.assemble の結果を渡します');
      }
      prog = p;
      mem.fill(0); screen.fill(0); regs.fill(0); dOp.fill(0); opCount = new Float64Array(NOPS + 2);
      mem.set(p.text, 0); mem.set(p.data, DATA_BASE);
      textEnd = p.textEnd; pc = p.entry >>> 0; steps = 0; halted = null;
      regs[2] = RAM_SIZE; regs[3] = DATA_BASE; regs[1] = textEnd;
      out = ''; u8need = 0; u8cp = 0; rng = seed0; keys = []; held = 0; frames = 0; screenUsed = false; priv = 3;
      for (const k in csr) csr[k] = 0;
      stop = 0; lastAddr = 0; branchN = 0; takenN = 0; lastTrap = null;
      if (pipe) pipe.reset();
      if (cache) cache.reset();
      return api;
    }

    const HELD_BIT = { 1: 1, 2: 2, 3: 4, 4: 8, 32: 16 };
    const api = {
      load,
      reset() { if (!prog) throw new Error('プログラムが読み込まれていません'); return load(prog); },
      run(o) {
        if (typeof o === 'string') o = { until: o };
        o = o || {};
        const limit = o.limit > 0 ? Math.floor(o.limit) : maxSteps;
        return exec(limit, o.until === 'frame');
      },
      step,
      regs, mem, screen,
      get pc() { return pc >>> 0; },
      set pc(v) { pc = v >>> 0; },
      get console() { return out; },
      get steps() { return steps; },
      get frames() { return frames; },
      get screenUsed() { return screenUsed; },
      get halted() { return halted ? result(halted.reason, 0) : null; },
      get prog() { return prog; },
      get priv() { return priv; },
      get csr() { return Object.assign({}, csr); },
      get stats() {
        const byOp = {}, byClass = { arith: 0, muldiv: 0, load: 0, store: 0, branch: 0, jump: 0, system: 0 };
        for (let op = 1; op <= NOPS; op++) if (opCount[op]) { byOp[OP_NAME[op]] = opCount[op]; byClass[OP_CLS[op]] += opCount[op]; }
        return { steps, byOp, byClass, branches: branchN, taken: takenN };
      },
      get pipeline() { return pipe; },
      get cache() { return cache; },
      get timing() {
        const ps = pipe ? pipe.stats : null, cs = cache ? cache.stats : null;
        const instructions = ps ? ps.instructions : steps;
        const pipelineCycles = ps ? ps.cycles : steps, cachePenalty = cs ? cs.penalty : 0;
        const cycles = pipelineCycles + cachePenalty;
        return { instructions, cycles, cpi: instructions ? cycles / instructions : 0, pipelineCycles, cachePenalty };
      },
      reg(r) { const i = regIndex(r); if (i < 0) throw new Error(`レジスタ \`${r}\` はありません`); return regs[i]; },
      setReg(r, v) { const i = regIndex(r); if (i < 0) throw new Error(`レジスタ \`${r}\` はありません`); if (i) regs[i] = v; },
      read8: (a) => peek(a, 1), read16: (a) => peek(a, 2), read32: (a) => peek(a, 4),
      write8: (a, v) => poke(a, 1, v), write32: (a, v) => poke(a, 4, v),
      readString(a) {
        const bytes = [];
        for (a >>>= 0; a < RAM_SIZE && mem[a] !== 0; a++) bytes.push(mem[a]);
        let s = '';
        for (let i = 0; i < bytes.length;) {
          const b = bytes[i];
          const n = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
          let cp = n === 0 ? b : n === 1 ? b & 0x1f : n === 2 ? b & 0x0f : b & 0x07, ok = n >= 0 && i + n < bytes.length;
          if (n > 0 && ok) for (let k = 1; k <= n; k++) { if ((bytes[i + k] & 0xc0) !== 0x80) { ok = false; break; } cp = (cp << 6) | (bytes[i + k] & 0x3f); }
          if (n === 0) { s += String.fromCharCode(b); i++; }
          else if (ok) { s += String.fromCodePoint(cp); i += n + 1; }
          else { s += '\ufffd'; i++; }
        }
        return s;
      },
      keyDown(code) {
        code = keyCode(code);
        if (!code) return;
        if (keys.length < 16) keys.push(code);
        if (HELD_BIT[code]) held |= HELD_BIT[code];
      },
      keyUp(code) { code = keyCode(code); if (HELD_BIT[code]) held &= ~HELD_BIT[code]; },
      key(code) { code = keyCode(code); if (code && keys.length < 16) keys.push(code); },
      snapshot() {
        return {
          mem: mem.slice(), screen: screen.slice(), regs: regs.slice(), pc, steps, halted, out, u8need, u8cp, rng, keys: keys.slice(), held, frames, screenUsed,
          priv, csr: Object.assign({}, csr), opCount: opCount.slice(), branchN, takenN, prog, textEnd,
          pipe: pipe ? pipe.save() : null, cache: cache ? cache.save() : null,
        };
      },
      restore(s) {
        mem.set(s.mem); screen.set(s.screen); regs.set(s.regs); dOp.fill(0);
        pc = s.pc; steps = s.steps; halted = s.halted; out = s.out; u8need = s.u8need; u8cp = s.u8cp; rng = s.rng; keys = s.keys.slice(); held = s.held;
        frames = s.frames; screenUsed = s.screenUsed; priv = s.priv; Object.assign(csr, s.csr); opCount = s.opCount.slice();
        branchN = s.branchN; takenN = s.takenN; prog = s.prog; textEnd = s.textEnd; stop = 0;
        if (pipe && s.pipe) pipe.load(s.pipe);
        if (cache && s.cache) cache.load(s.cache);
        return api;
      },
    };
    return api;
  }

  function run(src, opts) {
    opts = opts || {};
    const prog = assemble(src);
    if (!prog.ok) return { ok: false, prog, machine: null, result: null, console: '', errors: prog.errors };
    const m = machine(opts).load(prog);
    const result = m.run({ until: opts.until, limit: opts.limit });
    return { ok: result.reason !== 'error', prog, machine: m, result, console: m.console, errors: [] };
  }

  const INSTRUCTIONS = SPEC_SRC.map((s) => ({
    name: s[0], format: s[1], opcode: s[2], funct3: s[3] < 0 ? null : s[3], funct7: s[4] < 0 ? null : s[4], cls: s[5],
    word: s[0] in SYS_WORDS ? SYS_WORDS[s[0]] : null,
  }));
  const PSEUDO = [
    { name: 'nop', form: 'nop', expands: 'addi zero, zero, 0' },
    { name: 'li', form: 'li rd, 数', expands: 'addi rd, zero, 数（-2048〜2047 のとき）／ lui rd, 上位 + addi rd, rd, 下位' },
    { name: 'la', form: 'la rd, ラベル', expands: 'lui rd, %hi(ラベル) + addi rd, rd, %lo(ラベル)' },
    { name: 'mv', form: 'mv rd, rs', expands: 'addi rd, rs, 0' },
    { name: 'not', form: 'not rd, rs', expands: 'xori rd, rs, -1' },
    { name: 'neg', form: 'neg rd, rs', expands: 'sub rd, zero, rs' },
    { name: 'seqz', form: 'seqz rd, rs', expands: 'sltiu rd, rs, 1' },
    { name: 'snez', form: 'snez rd, rs', expands: 'sltu rd, zero, rs' },
    { name: 'sltz', form: 'sltz rd, rs', expands: 'slt rd, rs, zero' },
    { name: 'sgtz', form: 'sgtz rd, rs', expands: 'slt rd, zero, rs' },
    { name: 'sgt', form: 'sgt rd, rs, rt', expands: 'slt rd, rt, rs' },
    { name: 'sgtu', form: 'sgtu rd, rs, rt', expands: 'sltu rd, rt, rs' },
    { name: 'beqz', form: 'beqz rs, ラベル', expands: 'beq rs, zero, ラベル' },
    { name: 'bnez', form: 'bnez rs, ラベル', expands: 'bne rs, zero, ラベル' },
    { name: 'blez', form: 'blez rs, ラベル', expands: 'bge zero, rs, ラベル' },
    { name: 'bgez', form: 'bgez rs, ラベル', expands: 'bge rs, zero, ラベル' },
    { name: 'bltz', form: 'bltz rs, ラベル', expands: 'blt rs, zero, ラベル' },
    { name: 'bgtz', form: 'bgtz rs, ラベル', expands: 'blt zero, rs, ラベル' },
    { name: 'bgt', form: 'bgt rs, rt, ラベル', expands: 'blt rt, rs, ラベル' },
    { name: 'ble', form: 'ble rs, rt, ラベル', expands: 'bge rt, rs, ラベル' },
    { name: 'bgtu', form: 'bgtu rs, rt, ラベル', expands: 'bltu rt, rs, ラベル' },
    { name: 'bleu', form: 'bleu rs, rt, ラベル', expands: 'bgeu rt, rs, ラベル' },
    { name: 'j', form: 'j ラベル', expands: 'jal zero, ラベル' },
    { name: 'jal', form: 'jal ラベル', expands: 'jal ra, ラベル' },
    { name: 'jr', form: 'jr rs', expands: 'jalr zero, 0(rs)' },
    { name: 'jalr', form: 'jalr rs', expands: 'jalr ra, 0(rs)' },
    { name: 'ret', form: 'ret', expands: 'jalr zero, 0(ra)' },
    { name: 'call', form: 'call ラベル', expands: 'jal ra, ラベル' },
    { name: 'tail', form: 'tail ラベル', expands: 'jal zero, ラベル' },
    { name: 'lw', form: 'lw rd, ラベル', expands: 'lui rd, %hi(ラベル) + lw rd, %lo(ラベル)(rd)（lb lh lbu lhu も同じ）' },
    { name: 'sw', form: 'sw rs, ラベル, rt', expands: 'lui rt, %hi(ラベル) + sw rs, %lo(ラベル)(rt)（sb sh も同じ）' },
    { name: 'csrr', form: 'csrr rd, csr', expands: 'csrrs rd, csr, zero' },
    { name: 'csrw', form: 'csrw csr, rs', expands: 'csrrw zero, csr, rs' },
    { name: 'csrs', form: 'csrs csr, rs', expands: 'csrrs zero, csr, rs' },
    { name: 'csrc', form: 'csrc csr, rs', expands: 'csrrc zero, csr, rs' },
    { name: 'csrwi', form: 'csrwi csr, 数', expands: 'csrrwi zero, csr, 数' },
    { name: 'csrsi', form: 'csrsi csr, 数', expands: 'csrrsi zero, csr, 数' },
    { name: 'csrci', form: 'csrci csr, 数', expands: 'csrrci zero, csr, 数' },
  ];

  const RV = {
    assemble, disasm, decode, encode, machine, run,
    MAP, PALETTE, PALETTE_NAMES, ECALLS, CAUSES, CSR_NAMES, INSTRUCTIONS, PSEUDO,
    REG_NAMES, regIndex, regName, hex, u32, keyCode,
  };
  root.RV = RV;
  if (typeof module !== 'undefined' && module.exports) module.exports = RV;
})(typeof window !== 'undefined' ? window : globalThis);
