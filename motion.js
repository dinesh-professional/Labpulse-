/**
 * LabPulse — Dynamic Moving Background & Nebula Constellation System
 * High-performance, GPU-accelerated canvas engine with organic aurora waves,
 * multi-layered floating luminous particles, interactive constellation physics, and mouse dynamics.
 */
(function () {
  'use strict';

  function initBackgroundMotion() {
    var bgContainer = document.querySelector('.vortex-bg');
    if (!bgContainer) return;

    // Check if canvas already exists
    var existingCanvas = document.getElementById('vortex-motion-canvas');
    if (existingCanvas) {
      existingCanvas.remove();
    }

    var canvas = document.createElement('canvas');
    canvas.id = 'vortex-motion-canvas';
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '1';
    bgContainer.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var width = 0;
    var height = 0;
    var particles = [];
    var auroraBlobs = [];
    var mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000, active: false };
    var time = 0;

    // Color palette matching the LabPulse futuristic glassmorphic theme
    var colorPalette = [
      { r: 0, g: 245, b: 212 },   // Neon Cyan
      { r: 168, g: 85, b: 247 },  // Electric Violet
      { r: 16, g: 185, b: 129 },  // Vivid Emerald
      { r: 59, g: 130, b: 246 },  // Sapphire Blue
      { r: 236, g: 72, b: 153 }   // Pink Glow
    ];

    function resize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      initAuroraBlobs();
    }
    window.addEventListener('resize', resize);

    // Mouse tracking with smooth spring interpolation
    window.addEventListener('mousemove', function (e) {
      mouse.targetX = e.clientX;
      mouse.targetY = e.clientY;
      mouse.active = true;
    });

    window.addEventListener('mouseleave', function () {
      mouse.targetX = -1000;
      mouse.targetY = -1000;
      mouse.active = false;
    });

    // Aurora wave blobs for rich flowing background motion
    function initAuroraBlobs() {
      auroraBlobs = [
        {
          x: width * 0.2,
          y: height * 0.3,
          radius: Math.max(width, height) * 0.38,
          vx: 0.4,
          vy: 0.3,
          color: 'rgba(0, 245, 212, 0.12)',
          angle: 0,
          speed: 0.008
        },
        {
          x: width * 0.8,
          y: height * 0.4,
          radius: Math.max(width, height) * 0.42,
          vx: -0.35,
          vy: 0.45,
          color: 'rgba(168, 85, 247, 0.14)',
          angle: Math.PI / 2,
          speed: 0.006
        },
        {
          x: width * 0.45,
          y: height * 0.8,
          radius: Math.max(width, height) * 0.45,
          vx: 0.3,
          vy: -0.4,
          color: 'rgba(59, 130, 246, 0.12)',
          angle: Math.PI,
          speed: 0.007
        },
        {
          x: width * 0.7,
          y: height * 0.85,
          radius: Math.max(width, height) * 0.35,
          vx: -0.45,
          vy: -0.3,
          color: 'rgba(16, 185, 129, 0.10)',
          angle: Math.PI * 1.5,
          speed: 0.009
        }
      ];
    }

    // Particle constructor with multi-depth layers
    function Particle(layer) {
      this.layer = layer || (Math.random() > 0.6 ? 2 : 1); // 1 = background dust, 2 = foreground node
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.radius = this.layer === 2 ? Math.random() * 2.2 + 1.2 : Math.random() * 1.2 + 0.6;
      this.colorObj = colorPalette[Math.floor(Math.random() * colorPalette.length)];
      
      var speedScale = this.layer === 2 ? 0.75 : 0.35;
      this.vx = (Math.random() - 0.5) * speedScale;
      this.vy = (Math.random() - 0.5) * speedScale;
      
      this.pulseSpeed = Math.random() * 0.035 + 0.015;
      this.pulse = Math.random() * Math.PI * 2;
      this.baseAlpha = this.layer === 2 ? Math.random() * 0.45 + 0.35 : Math.random() * 0.25 + 0.15;
      this.wobble = Math.random() * Math.PI * 2;
      this.wobbleSpeed = Math.random() * 0.02 + 0.005;
    }

    Particle.prototype.update = function () {
      this.pulse += this.pulseSpeed;
      this.wobble += this.wobbleSpeed;

      // Natural curved drifting physics
      this.x += this.vx + Math.sin(this.wobble) * 0.25;
      this.y += this.vy + Math.cos(this.wobble) * 0.25;

      // Toroidal screen wrapping
      if (this.x < -30) this.x = width + 30;
      if (this.x > width + 30) this.x = -30;
      if (this.y < -30) this.y = height + 30;
      if (this.y > height + 30) this.y = -30;

      // Fluid mouse repulsion/attraction force
      if (mouse.x > -500 && mouse.y > -500) {
        var dx = this.x - mouse.x;
        var dy = this.y - mouse.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var maxDist = 180;
        if (dist < maxDist && dist > 0) {
          var force = (1 - dist / maxDist);
          var push = force * (this.layer === 2 ? 4.5 : 2.0);
          this.x += (dx / dist) * push;
          this.y += (dy / dist) * push;
        }
      }
    };

    Particle.prototype.draw = function () {
      var currentAlpha = this.baseAlpha * (0.65 + 0.35 * Math.sin(this.pulse));
      var c = this.colorObj;

      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + currentAlpha + ')';

      if (this.layer === 2) {
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ', 0.85)';
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.fill();
    };

    // Initialize particle pool (65 lively particles)
    var numParticles = 65;
    for (var i = 0; i < numParticles; i++) {
      particles.push(new Particle());
    }

    resize();

    // Render loop with requestAnimationFrame
    var animFrameId;
    function render() {
      time += 0.015;

      // Mouse smooth interpolation
      mouse.x += (mouse.targetX - mouse.x) * 0.08;
      mouse.y += (mouse.targetY - mouse.y) * 0.08;

      ctx.clearRect(0, 0, width, height);

      // 1. Draw dynamic organic aurora gradient clouds
      for (var b = 0; b < auroraBlobs.length; b++) {
        var blob = auroraBlobs[b];
        blob.angle += blob.speed;
        var currentX = blob.x + Math.sin(blob.angle) * (width * 0.12);
        var currentY = blob.y + Math.cos(blob.angle * 1.3) * (height * 0.10);

        var grad = ctx.createRadialGradient(
          currentX, currentY, 0,
          currentX, currentY, blob.radius
        );
        grad.addColorStop(0, blob.color);
        grad.addColorStop(0.6, 'rgba(10, 13, 18, 0.02)');
        grad.addColorStop(1, 'rgba(10, 13, 18, 0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(currentX, currentY, blob.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Interactive mouse glow spotlight
      if (mouse.x > -500 && mouse.y > -500) {
        var mouseGrad = ctx.createRadialGradient(
          mouse.x, mouse.y, 0,
          mouse.x, mouse.y, 220
        );
        mouseGrad.addColorStop(0, 'rgba(0, 245, 212, 0.08)');
        mouseGrad.addColorStop(0.5, 'rgba(168, 85, 247, 0.04)');
        mouseGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = mouseGrad;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 220, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Draw connecting constellation lines between nearby particles
      var maxConnectDist = 135;
      for (var i = 0; i < particles.length; i++) {
        if (particles[i].layer !== 2) continue;
        for (var j = i + 1; j < particles.length; j++) {
          if (particles[j].layer !== 2) continue;

          var dx = particles[i].x - particles[j].x;
          var dy = particles[i].y - particles[j].y;
          var dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < maxConnectDist) {
            var lineAlpha = (1 - dist / maxConnectDist) * 0.22;
            var ci = particles[i].colorObj;
            
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = 'rgba(' + ci.r + ',' + ci.g + ',' + ci.b + ',' + lineAlpha + ')';
            ctx.lineWidth = 0.9;
            ctx.shadowBlur = 0;
            ctx.stroke();
          }
        }
      }

      // 4. Update & draw all particles
      for (var k = 0; k < particles.length; k++) {
        particles[k].update();
        particles[k].draw();
      }

      animFrameId = requestAnimationFrame(render);
    }

    // Check reduced motion preference
    var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!prefersReduced.matches) {
      render();
    }
  }

  // Auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBackgroundMotion);
  } else {
    initBackgroundMotion();
  }
})();
