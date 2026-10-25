(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  const ui = {
    ballCount: document.getElementById("ballCount"),
    spawnRate: document.getElementById("spawnRate"),
    collisionCount: document.getElementById("collisionCount"),
    collisionRate: document.getElementById("collisionRate"),
    pauseBtn: document.getElementById("pauseBtn"),
    resetBtn: document.getElementById("resetBtn"),
    soundBtn: document.getElementById("soundBtn"),
    speedSlider: document.getElementById("speedSlider"),
    speedValue: document.getElementById("speedValue"),
    speedPresets: [...document.querySelectorAll(".speed-preset")],
  };

  // --- Tunables ---
  const START_BALLS = 2;
  const START_RADIUS = 27;
  const MIN_RADIUS = 2.2;          // hard size floor
  const SHRINK_PER_BALL = 0.0085;  // controls how fast all balls shrink
  const BASE_SPEED = 245;
  const MAX_SPEED = 520;
  const RING_RADIUS = 390;
  const RING_LINE = 10;
  const SPAWN_NUDGE = 5;
  const MAX_SUBSTEPS = 20;

  const COLORS = [
    "#ff5d73", "#5db8ff", "#ffd45d", "#7cff8c",
    "#b987ff", "#ff8fe6", "#66f5df", "#ff9c5d"
  ];

  let balls = [];
  let nextBallId = 1;
  let collisionCount = 0;
  let recentSpawns = [];
  let recentCollisions = [];
  let activePairs = new Set();
  let paused = false;
  let soundOn = true;
  let simSpeed = 1;
  let lastTime = performance.now();
  let audioCtx = null;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function currentRadius() {
    // Smooth shrink curve. Starts near START_RADIUS and asymptotically reaches MIN_RADIUS.
    const n = Math.max(0, balls.length - START_BALLS);
    return Math.max(MIN_RADIUS, START_RADIUS / (1 + n * SHRINK_PER_BALL));
  }

  function updateAllRadii() {
    const r = currentRadius();
    for (const b of balls) b.r = r;
  }

  function makeBall(x, y, speed = BASE_SPEED, angle = Math.random() * Math.PI * 2) {
    const s = Math.min(MAX_SPEED, speed);
    return {
      id: nextBallId++,
      x, y,
      vx: Math.cos(angle) * s,
      vy: Math.sin(angle) * s,
      r: currentRadius(),
      color: COLORS[(nextBallId - 2) % COLORS.length]
    };
  }

  function reset() {
    balls = [];
    activePairs.clear();
    recentSpawns = [];
    recentCollisions = [];
    collisionCount = 0;
    nextBallId = 1;

    const offset = 110;
    balls.push(makeBall(-offset, 0, BASE_SPEED, 0.55));
    balls.push(makeBall(offset, 0, BASE_SPEED, Math.PI + 0.55));

    updateAllRadii();
    updateUI(performance.now());
  }

  function pairKey(a, b) {
    return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  }

  function ensureAudio() {
    if (!soundOn) return null;
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function tone(type, freq, duration, gainAmount, when = 0, endFreq = null) {
    const ac = ensureAudio();
    if (!ac) return;
    const t = ac.currentTime + when;
    const osc = ac.createOscillator();
    const gain = ac.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(30, freq), t);
    if (endFreq && endFreq > 0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), t + duration);
    }

    gain.gain.setValueAtTime(Math.max(0.0001, gainAmount), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  }

  function noiseBurst(duration = 0.035, gainAmount = 0.012, highpass = 900) {
    const ac = ensureAudio();
    if (!ac) return;

    const length = Math.max(1, Math.floor(ac.sampleRate * duration));
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }

    const src = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const gain = ac.createGain();

    filter.type = "highpass";
    filter.frequency.value = highpass;
    gain.gain.setValueAtTime(gainAmount, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);

    src.buffer = buffer;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    src.start();
  }

  function playCollisionSpawnSound(ballCount) {
    if (!soundOn) return;

    const density = Math.min(1, Math.log10(ballCount + 1) / 3);
    const base = 380 - density * 145 + Math.random() * 85;

    // Main "clack"
    tone("triangle", base, 0.055, 0.026, 0, base * 0.52);
    noiseBurst(0.028, 0.010, 1200);

    // Tiny spawn "pip" above it
    tone("sine", base * 1.75, 0.04, 0.012, 0.006, base * 1.25);

    // At high populations, add a low thump so the chaos sounds heavier.
    if (ballCount >= 40 && Math.random() < 0.34) {
      tone("sine", 105 + Math.random() * 35, 0.07, 0.016, 0, 62);
    }
  }

  function playWallSound(speed) {
    if (!soundOn) return;

    const strength = Math.min(1, Math.max(0.2, speed / MAX_SPEED));
    const f = 145 + strength * 145 + Math.random() * 40;
    tone("square", f, 0.026, 0.006 + strength * 0.006, 0, f * 0.72);
  }

  function playUiClick(pitch = 520) {
    if (!soundOn) return;
    tone("sine", pitch, 0.035, 0.016, 0, pitch * 0.82);
  }

  function spawnFromCollision(a, b, now) {
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;

    const side = Math.random() < 0.5 ? -1 : 1;
    const px = -ny * side;
    const py = nx * side;

    const inheritedVX = (a.vx + b.vx) * 0.5;
    const inheritedVY = (a.vy + b.vy) * 0.5;
    const inheritedSpeed = Math.max(
      BASE_SPEED * 0.82,
      Math.min(MAX_SPEED, Math.hypot(inheritedVX, inheritedVY) * 0.85 + 55)
    );

    const angle = Math.atan2(py, px) + rand(-0.5, 0.5);
    const newBall = makeBall(
      mx + px * SPAWN_NUDGE,
      my + py * SPAWN_NUDGE,
      inheritedSpeed,
      angle
    );

    balls.push(newBall);
    updateAllRadii();

    recentSpawns.push(now);
    playCollisionSpawnSound(balls.length);
  }

  function resolveBallCollision(a, b) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distSq = dx * dx + dy * dy;
    const minDist = a.r + b.r;

    if (distSq === 0) {
      dx = 0.0001;
      dy = 0;
      distSq = dx * dx;
    }

    if (distSq >= minDist * minDist) return false;

    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;

    // Positional correction to stop balls from remaining embedded.
    const overlap = minDist - dist;
    const push = overlap * 0.5 + 0.02;
    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;

    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const velAlongNormal = rvx * nx + rvy * ny;

    if (velAlongNormal < 0) {
      // Equal mass, almost-elastic impulse.
      const restitution = 0.985;
      const impulse = -(1 + restitution) * velAlongNormal * 0.5;

      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;

      capSpeed(a);
      capSpeed(b);
    }

    return true;
  }

  function capSpeed(b) {
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      const k = MAX_SPEED / speed;
      b.vx *= k;
      b.vy *= k;
    } else if (speed < 60) {
      const k = 60 / Math.max(speed, 0.0001);
      b.vx *= k;
      b.vy *= k;
    }
  }

  function resolveWall(b) {
    const maxCenterDist = RING_RADIUS - RING_LINE * 0.5 - b.r;
    const d = Math.hypot(b.x, b.y);

    if (d <= maxCenterDist || d === 0) return;

    const nx = b.x / d;
    const ny = b.y / d;

    b.x = nx * maxCenterDist;
    b.y = ny * maxCenterDist;

    const velNormal = b.vx * nx + b.vy * ny;
    if (velNormal > 0) {
      const impactSpeed = Math.abs(velNormal);
      b.vx -= 2 * velNormal * nx;
      b.vy -= 2 * velNormal * ny;
      b.vx *= 0.997;
      b.vy *= 0.997;
      playWallSound(impactSpeed);
    }

    capSpeed(b);
  }

  function physicsStep(dt, now) {
    for (const b of balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      resolveWall(b);
    }

    // Spatial hash keeps collision checks much faster than naïve O(n²) at higher counts.
    const r = currentRadius();
    const cellSize = Math.max(8, r * 2.15);
    const grid = new Map();

    function cellKey(cx, cy) {
      return `${cx},${cy}`;
    }

    for (const b of balls) {
      const cx = Math.floor((b.x + RING_RADIUS) / cellSize);
      const cy = Math.floor((b.y + RING_RADIUS) / cellSize);
      const key = cellKey(cx, cy);
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, bucket = []);
      bucket.push(b);
    }

    const touchingThisStep = new Set();

    for (const [key, bucket] of grid) {
      const [cx, cy] = key.split(",").map(Number);

      for (const a of bucket) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const other = grid.get(cellKey(cx + ox, cy + oy));
            if (!other) continue;

            for (const b of other) {
              if (a.id >= b.id) continue;

              const keyAB = pairKey(a, b);
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const sumR = a.r + b.r;

              if (dx * dx + dy * dy <= sumR * sumR) {
                touchingThisStep.add(keyAB);
                const isNewContact = !activePairs.has(keyAB);

                if (resolveBallCollision(a, b) && isNewContact) {
                  collisionCount++;
                  recentCollisions.push(now);
                  spawnFromCollision(a, b, now);
                }
              }
            }
          }
        }
      }
    }

    activePairs = touchingThisStep;
  }

  function updateUI(now) {
    const cutoff = now - 1000;

    while (recentSpawns.length && recentSpawns[0] < cutoff) recentSpawns.shift();
    while (recentCollisions.length && recentCollisions[0] < cutoff) recentCollisions.shift();

    ui.ballCount.textContent = balls.length.toLocaleString();
    ui.spawnRate.textContent = recentSpawns.length.toFixed(1);
    ui.collisionCount.textContent = collisionCount.toLocaleString();
    ui.collisionRate.textContent = recentCollisions.length.toFixed(1);
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const scale = w / 900;

    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);

    // soft interior glow
    const glow = ctx.createRadialGradient(0, 0, 40, 0, 0, RING_RADIUS + 35);
    glow.addColorStop(0, "rgba(255,255,255,0.025)");
    glow.addColorStop(0.78, "rgba(255,255,255,0.01)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, RING_RADIUS + 28, 0, Math.PI * 2);
    ctx.fill();

    // ring
    ctx.lineWidth = RING_LINE;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.shadowColor = "rgba(255,255,255,.26)";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // balls
    for (const b of balls) {
      const grad = ctx.createRadialGradient(
        b.x - b.r * 0.36, b.y - b.r * 0.42, b.r * 0.12,
        b.x, b.y, b.r
      );
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.18, b.color);
      grad.addColorStop(1, b.color);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(300, Math.floor(Math.min(rect.width, rect.height) * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  function frame(now) {
    resizeCanvas();

    const rawDt = Math.min(0.035, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;

    if (!paused) {
      const scaledDt = rawDt * simSpeed;

      // At high speed, split simulation time into smaller chunks so collisions still work.
      const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(scaledDt / 0.009)));
      const dt = scaledDt / substeps;

      for (let i = 0; i < substeps; i++) {
        physicsStep(dt, now);
      }
    }

    updateUI(now);
    draw();
    requestAnimationFrame(frame);
  }

  function setSpeed(value, withSound = true) {
    simSpeed = Math.min(10, Math.max(1, Number(value) || 1));
    ui.speedSlider.value = String(simSpeed);
    ui.speedValue.textContent = `${Number.isInteger(simSpeed) ? simSpeed : simSpeed.toFixed(1)}×`;

    for (const btn of ui.speedPresets) {
      btn.classList.toggle("active", Number(btn.dataset.speed) === simSpeed);
    }

    if (withSound) {
      playUiClick(430 + simSpeed * 32);
    }
  }

  ui.speedSlider.addEventListener("input", () => {
    setSpeed(ui.speedSlider.value, false);
  });

  ui.speedSlider.addEventListener("change", () => {
    playUiClick(430 + simSpeed * 32);
  });

  for (const btn of ui.speedPresets) {
    btn.addEventListener("click", () => {
      setSpeed(btn.dataset.speed, true);
    });
  }

  ui.pauseBtn.addEventListener("click", () => {
    playUiClick(paused ? 600 : 360);
    paused = !paused;
    ui.pauseBtn.textContent = paused ? "RESUME" : "PAUSE";
  });

  ui.resetBtn.addEventListener("click", () => {
    playUiClick(260);
    reset();
    paused = false;
    ui.pauseBtn.textContent = "PAUSE";
  });

  ui.soundBtn.addEventListener("click", () => {
    const wasOn = soundOn;
    soundOn = !soundOn;
    ui.soundBtn.textContent = `SOUND: ${soundOn ? "ON" : "OFF"}`;
    ui.soundBtn.setAttribute("aria-pressed", String(soundOn));
    if (soundOn && audioCtx?.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    if (!wasOn && soundOn) playUiClick(700);
  });

  // Wake audio on first intentional interaction.
  window.addEventListener("pointerdown", () => {
    if (!soundOn) return;
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {}
    }
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
  }, { once: true });

  // Prevent iOS double-tap zoom behavior on the game surface.
  let lastTouchEnd = 0;
  document.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  setSpeed(1, false);
  reset();
  requestAnimationFrame(frame);
})();
