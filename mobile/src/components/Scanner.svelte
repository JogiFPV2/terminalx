<script lang="ts">
  // Skaner kodu QR w samej aplikacji: obraz z aparatu przez getUserMedia (WebView prosi o uprawnienie do aparatu)
  // i dekoder jsQR. Zastępuje natywną wtyczkę skanera, która wywracała aplikację na telefonie.
  import { onMount } from 'svelte';
  import jsQR from 'jsqr';
  import Icon from '../../../src/lib/Icon.svelte';

  let { onresult, onclose }: { onresult: (text: string) => void; onclose: () => void } = $props();
  let video: HTMLVideoElement;
  let error = $state('');
  let stream: MediaStream | null = null;
  let raf = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function stop() { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); stream = null; }

  function tick() {
    if (!stream) return;
    if (video.readyState >= 2 && ctx) {
      // Mniejsza klatka wystarcza do kodu z ekranu komputera i jest szybsza do dekodowania.
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (code?.data) { navigator.vibrate?.(40); stop(); onresult(code.data); return; }
    }
    raf = requestAnimationFrame(tick);
  }

  onMount(() => {
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Ten WebView nie daje dostępu do aparatu.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = stream;
        await video.play();
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const n = (e as Error)?.name;
        error = n === 'NotAllowedError' ? 'Brak zgody na aparat. Zezwól w ustawieniach Androida (Aplikacje → Hermitty → Uprawnienia) albo wklej link.'
          : n === 'NotFoundError' ? 'Nie znaleziono aparatu. Wklej link spod kodu.'
          : `Aparat nie ruszył: ${String((e as Error)?.message || e)}`;
      }
    })();
    return stop;
  });
</script>

<div class="scan" role="dialog" aria-modal="true" aria-label="Skanowanie kodu QR">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} playsinline muted></video>
  <div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
  <p class="hint">{error || 'Skieruj aparat na kod QR na ekranie komputera'}</p>
  <button class="close" aria-label="Zamknij skaner" onclick={() => { stop(); onclose(); }}><Icon name="x" size={22} /></button>
</div>

<style>
  .scan { position: fixed; inset: 0; z-index: 100; background: #000; display: grid; place-items: center; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .frame { position: relative; width: min(70vw, 300px); aspect-ratio: 1; box-shadow: 0 0 0 100vmax rgb(0 0 0 / .45); border-radius: 20px; }
  .frame i { position: absolute; width: 36px; height: 36px; border: 4px solid var(--primary, #E4EE6B); }
  .frame i:nth-child(1) { top: 0; left: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 20px; }
  .frame i:nth-child(2) { top: 0; right: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 20px; }
  .frame i:nth-child(3) { bottom: 0; left: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 20px; }
  .frame i:nth-child(4) { bottom: 0; right: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 20px; }
  .hint { position: absolute; left: 24px; right: 24px; bottom: calc(110px + var(--safe-b)); margin: 0; text-align: center; color: #fff; font-size: 15px; text-shadow: 0 1px 4px rgb(0 0 0 / .6); }
  .close { position: absolute; top: calc(16px + var(--safe-t)); right: 16px; width: 48px; height: 48px; border-radius: 50%; border: 0; background: rgb(255 255 255 / .18); color: #fff; display: grid; place-items: center; }
</style>
