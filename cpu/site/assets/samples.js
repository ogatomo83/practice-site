// 実験場（playground.html）のサンプル。どれも rv.js / logic.js で動作を確かめてある。
// speed は「1 フレームあたりの命令数」の初期値。anim は画面を使って動き続けるプログラム。
(function (root) {
  const asm = [];
  const logic = [];

  asm.push({ id: 'hello', title: 'Hello（文字列を出す）', speed: 1, src: `# コンソールに文字列を出す
.data
msg:  .string "Hello, RISC-V!\\nこんにちは、世界\\n"

.text
main:
  la   a0, msg        # a0 = 文字列の番地
  li   a7, 4          # 4 = a0 の番地の文字列を表示
  ecall
  li   a7, 10         # 10 = 終了
  ecall
` });

  asm.push({ id: 'sum', title: '1 から 100 までの合計', speed: 10, src: `# 1 から 100 までの合計を求めて表示する
main:
  li   t0, 1          # t0 = いま足す数
  li   t1, 100        # t1 = 最後の数
  li   a0, 0          # a0 = 合計
loop:
  add  a0, a0, t0     # 合計に足す
  addi t0, t0, 1      # 次の数へ
  ble  t0, t1, loop   # 100 以下なら繰り返す

  li   a7, 1          # 1 = a0 を整数で表示
  ecall
  li   a7, 10         # 10 = 終了
  ecall
` });

  asm.push({ id: 'fib', title: '再帰のフィボナッチ', speed: 100, src: `# fib(0) から fib(15) までを、再帰の関数で求めて並べる
main:
  li   s0, 0          # s0 = n
  li   s1, 15
next:
  mv   a0, s0
  call fib            # a0 = fib(n)
  li   a7, 1
  ecall
  li   a0, ' '
  li   a7, 11         # 11 = a0 の文字を表示
  ecall
  addi s0, s0, 1
  ble  s0, s1, next
  li   a7, 10
  ecall

# fib(n)：n < 2 なら n、それ以外は fib(n-1) + fib(n-2)
fib:
  li   t0, 2
  blt  a0, t0, fib_end
  addi sp, sp, -16    # スタックに 16 バイトの場所を取る
  sw   ra, 12(sp)     # 戻り先と、使うレジスタを退避
  sw   s0, 8(sp)
  sw   s1, 4(sp)
  mv   s0, a0         # s0 = n
  addi a0, s0, -1
  call fib            # fib(n-1)
  mv   s1, a0
  addi a0, s0, -2
  call fib            # fib(n-2)
  add  a0, a0, s1
  lw   ra, 12(sp)     # 退避したものを戻す
  lw   s0, 8(sp)
  lw   s1, 4(sp)
  addi sp, sp, 16
fib_end:
  ret
` });

  asm.push({ id: 'ball', title: '跳ねるボール', anim: true, speed: 100000, src: `# 跳ねるボール。通った跡を紺色で残す
.equ SCREEN, 0x10000  # 画面の先頭。(x, y) は SCREEN + y*32 + x
.equ FRAME,  0x20010  # ここに書くと 1 フレーム描かれる

main:
  li   s0, 5          # s0 = x
  li   s1, 9          # s1 = y
  li   s2, 1          # s2 = x の向き（+1 か -1）
  li   s3, 1          # s3 = y の向き
  li   s4, SCREEN
  li   s5, FRAME
  li   s6, 31         # 右端・下端
loop:
  slli t0, s1, 5      # いまの位置を跡の色にする
  add  t0, t0, s0
  add  t0, t0, s4
  li   t1, 14         # 14 = 紺
  sb   t1, 0(t0)

  add  s0, s0, s2     # 1 マス進む
  add  s1, s1, s3
  beqz s0, flip_x     # 左右の壁に着いたら向きを反転
  bne  s0, s6, check_y
flip_x:
  neg  s2, s2
check_y:
  beqz s1, flip_y     # 上下の壁
  bne  s1, s6, draw
flip_y:
  neg  s3, s3
draw:
  slli t0, s1, 5      # 新しい位置にボールを描く
  add  t0, t0, s0
  add  t0, t0, s4
  li   t1, 5          # 5 = 黄
  sb   t1, 0(t0)
  sw   zero, 0(s5)    # 1 フレーム終わり
  sw   zero, 0(s5)    # もう 1 フレーム待つ（速さの調整）
  j    loop
` });

  asm.push({ id: 'life', title: 'ライフゲーム', anim: true, speed: 1000000, src: `# ライフゲーム。画面のメモリをそのまま盤面として使う（0 = 死、0 以外 = 生）
.equ SCREEN, 0x10000
.equ RANDOM, 0x20008  # 読むたびに乱数
.equ FRAME,  0x20010

.data
next: .space 1024     # 次の世代を作る場所

.text
main:
  li   s0, SCREEN
  la   s1, next
  li   s2, 1024
  li   t0, 0          # 乱数で初期化（8 通りのうち 2 通りを生に）
  li   t3, RANDOM
init:
  lw   t1, 0(t3)
  srli t1, t1, 8
  andi t1, t1, 7
  sltiu t1, t1, 2     # 0 か 1
  slli t2, t1, 1
  add  t1, t1, t2     # 0 か 3（3 = 緑）
  add  t2, s0, t0
  sb   t1, 0(t2)
  addi t0, t0, 1
  blt  t0, s2, init
  li   t0, FRAME
  sw   zero, 0(t0)

gen:                  # 1 世代ぶん
  li   s3, 0          # s3 = y
row:
  li   s4, 0          # s4 = x
cell:
  li   t6, 0          # t6 = 生きている隣の数
  li   t0, -1         # t0 = dy
dy_loop:
  li   t1, -1         # t1 = dx
dx_loop:
  or   t2, t0, t1
  beqz t2, skip       # 自分自身は数えない
  add  t3, s3, t0
  andi t3, t3, 31     # 端は反対側につながる
  add  t4, s4, t1
  andi t4, t4, 31
  slli t3, t3, 5
  add  t3, t3, t4
  add  t3, t3, s0
  lbu  t5, 0(t3)
  snez t5, t5
  add  t6, t6, t5
skip:
  addi t1, t1, 1
  li   t2, 2
  blt  t1, t2, dx_loop
  addi t0, t0, 1
  blt  t0, t2, dy_loop

  slli t3, s3, 5      # ルール：隣が 3 なら生、2 なら今のまま、ほかは死
  add  t3, t3, s4     # t3 = y*32 + x
  add  t4, t3, s0
  lbu  t5, 0(t4)      # t5 = 今の状態
  li   t2, 3
  beq  t6, t2, born
  li   t2, 2
  beq  t6, t2, store
  li   t5, 0
  j    store
born:
  li   t5, 3
store:
  add  t4, t3, s1
  sb   t5, 0(t4)
  addi s4, s4, 1
  li   t2, 32
  blt  s4, t2, cell
  addi s3, s3, 1
  blt  s3, t2, row

  li   t0, 0          # next を画面に写す（4 バイトずつ）
copy:
  add  t1, s1, t0
  lw   t2, 0(t1)
  add  t1, s0, t0
  sw   t2, 0(t1)
  addi t0, t0, 4
  blt  t0, s2, copy
  li   t0, FRAME
  sw   zero, 0(t0)
  j    gen
` });

  asm.push({ id: 'game', title: 'エサあつめ（矢印キーで動かす）', anim: true, speed: 100000, src: `# エサあつめ：画面をクリックしてから、矢印キーで向きを変える。
# 赤いエサを食べると体が伸びる。自分の体にぶつかると、食べた数を出して最初から。
.equ SCREEN, 0x10000
.equ KEY,    0x20004  # 読むと、押されたキーのコード（← 1、↑ 2、→ 3、↓ 4、なければ 0）
.equ RANDOM, 0x20008
.equ FRAME,  0x20010

.data
body: .space 4096     # 体の位置（y*32 + x）を古い順に入れる輪。1024 個ぶん
msg:  .string "食べた数: "

.text
main:
  li   s0, SCREEN
  la   s1, body
restart:
  li   t0, 0          # 画面を消す
  li   t1, 1024
clear:
  add  t2, s0, t0
  sw   zero, 0(t2)
  addi t0, t0, 4
  blt  t0, t1, clear
  li   s2, 16*32+8    # s2 = 頭の位置
  li   s3, 1          # s3 = x の向き
  li   s4, 0          # s4 = y の向き
  li   s5, 0          # s5 = 輪の中の、しっぽの番号
  li   s6, 0          # s6 = 輪の中の、頭の番号
  li   s7, 0          # s7 = 食べた数
  sw   s2, 0(s1)      # 体は最初 1 マス
  add  t0, s0, s2
  li   t1, 5          # 頭は黄
  sb   t1, 0(t0)
  call food

tick:
  li   t0, 6          # 6 フレーム待つ（速さの調整）
  li   t1, FRAME
wait:
  sw   zero, 0(t1)
  addi t0, t0, -1
  bnez t0, wait

  li   t1, KEY        # キーを 1 つ読んで向きを変える（真後ろには向けない）
  lw   t0, 0(t1)
  li   t2, 1
  bne  t0, t2, key_up
  li   t3, 1
  beq  s3, t3, move
  li   s3, -1         # ←
  li   s4, 0
  j    move
key_up:
  li   t2, 2
  bne  t0, t2, key_right
  li   t3, 1
  beq  s4, t3, move
  li   s3, 0          # ↑
  li   s4, -1
  j    move
key_right:
  li   t2, 3
  bne  t0, t2, key_down
  li   t3, -1
  beq  s3, t3, move
  li   s3, 1          # →
  li   s4, 0
  j    move
key_down:
  li   t2, 4
  bne  t0, t2, move
  li   t3, -1
  beq  s4, t3, move
  li   s3, 0          # ↓
  li   s4, 1

move:
  andi t0, s2, 31     # t0 = x
  srli t1, s2, 5      # t1 = y
  add  t0, t0, s3
  andi t0, t0, 31     # 端から出たら反対側へ
  add  t1, t1, s4
  andi t1, t1, 31
  slli t1, t1, 5
  add  t2, t1, t0     # t2 = 新しい頭の位置
  add  t3, s0, t2
  lbu  t4, 0(t3)      # t4 = そこにあるもの
  li   t5, 3
  beq  t4, t5, over   # 自分の体（緑）にぶつかった

  add  t5, s0, s2     # 今までの頭を体の色に
  li   t6, 3
  sb   t6, 0(t5)
  li   t6, 5          # 新しい頭を描く
  sb   t6, 0(t3)
  mv   s2, t2
  addi s6, s6, 1      # 輪に新しい頭の位置を入れる
  andi s6, s6, 1023
  slli t5, s6, 2
  add  t5, t5, s1
  sw   s2, 0(t5)
  li   t5, 2
  beq  t4, t5, eat    # エサ（赤）だった

  slli t5, s5, 2      # 食べなかったので、しっぽを 1 マス消す
  add  t5, t5, s1
  lw   t5, 0(t5)
  add  t5, t5, s0
  sb   zero, 0(t5)
  addi s5, s5, 1
  andi s5, s5, 1023
  j    tick
eat:
  addi s7, s7, 1      # しっぽを消さないので、体が 1 マス伸びる
  call food
  j    tick

food:                 # 空いているマスにエサを置く
  li   t0, RANDOM
  lw   t1, 0(t0)
  srli t1, t1, 4
  andi t1, t1, 1023
  add  t1, t1, s0
  lbu  t2, 0(t1)
  bnez t2, food       # 何かあるマスならやり直し
  li   t2, 2          # 2 = 赤
  sb   t2, 0(t1)
  ret

over:
  la   a0, msg
  li   a7, 4
  ecall
  mv   a0, s7
  li   a7, 1
  ecall
  li   a0, '\\n'
  li   a7, 11
  ecall
  li   t0, 40         # 少し待ってから最初へ
  li   t1, FRAME
over_wait:
  sw   zero, 0(t1)
  addi t0, t0, -1
  bnez t0, over_wait
  j    restart
` });

  logic.push({ id: 'half', title: '半加算器', src: `# 半加算器：1 ビットどうしの足し算
in a, b
out s, c
s = a xor b     # 和
c = a and b     # 繰り上がり
` });

  logic.push({ id: 'adder4', title: '4 ビットの加算器（部品を並べる）', src: `# 全加算器を 4 個つないだ、4 ビットの加算器
def fa(a, b, cin) -> (s, cout) {
  s = a xor b xor cin
  cout = (a and b) or (cin and (a xor b))
}

in a[4], b[4]
out sum[4], carry
wire c[5]
c[0] = 0
sum[0], c[1] = fa(a[0], b[0], c[0])
sum[1], c[2] = fa(a[1], b[1], c[1])
sum[2], c[3] = fa(a[2], b[2], c[2])
sum[3], c[4] = fa(a[3], b[3], c[3])
carry = c[4]

test a=3, b=5
test a=9, b=6
test a=15, b=1
test a=8, b=8
` });

  logic.push({ id: 'mux', title: 'マルチプレクサ（選ぶ回路）', src: `# s が 0 なら a、1 なら b を出す
in s, a, b
out y
y = (a and not s) or (b and s)
` });

  logic.push({ id: 'counter', title: 'カウンタ（クロックで数える）', src: `# 4 ビットのカウンタ。en が 1 の間、クロックのたびに 1 増える
in en
out q[4]
reg q[4] = mux(en, q, q + 1)

step en=1
clock 5
step en=0
clock 2
step en=1
clock 3
` });

  logic.push({ id: 'latch', title: 'SR ラッチ（覚える回路）', src: `# NOR 2 個の SR ラッチ。s でセット、r でリセット、どちらも 0 なら前の値を保つ
in s, r
out q, nq
q  = r nor nq
nq = s nor q

step s=1, r=0
step s=0, r=0
step s=0, r=1
step s=0, r=0
` });

  root.CPU_SAMPLES = { asm, logic };
})(typeof window !== 'undefined' ? window : globalThis);
