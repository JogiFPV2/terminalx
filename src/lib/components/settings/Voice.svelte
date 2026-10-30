<script lang="ts">
  import Icon from '../../Icon.svelte';
  import { app, ui } from '../../state.svelte';
  import { audioProviders, sttProvider, ttsProvider, defaultSttModel, systemVoices, speak, stopSpeaking, voice } from '../../voice.svelte';

  const LANGS: [string, string][] = [['auto', 'Rozpoznaj sam'], ['pl', 'Polski'], ['en', 'English'], ['de', 'Deutsch'], ['uk', 'Українська'], ['es', 'Español'], ['fr', 'Français']];
  const STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1', 'whisper-large-v3-turbo', 'whisper-large-v3'];
  const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
  const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

  const providers = $derived(audioProviders());
  const stt = $derived(sttProvider());
  const tts = $derived(ttsProvider());

  // Lista głosów systemu dociera asynchronicznie (zdarzenie voiceschanged).
  let voices = $state<SpeechSynthesisVoice[]>(systemVoices());
  $effect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const upd = () => (voices = speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', upd);
    return () => speechSynthesis.removeEventListener('voiceschanged', upd);
  });
  const sorted = $derived([...voices].sort((a, b) => Number(b.lang.startsWith('pl')) - Number(a.lang.startsWith('pl')) || a.name.localeCompare(b.name)));

  const SAMPLE = 'Cześć! Tak będę czytać odpowiedzi agentów. Kod pomijam, żeby nie literować nawiasów.';
  const testing = $derived(voice.speaking === 'voice-test');
  function test() { if (testing) stopSpeaking(); else { stopSpeaking(); speak('voice-test', SAMPLE); } }
</script>

<h2>Głos</h2>
<p class="hint">Przycisk mikrofonu w panelu agenta nagrywa wiadomość i zamienia ją na tekst. Agent może też czytać odpowiedzi na głos (głośnik w nagłówku panelu albo przy każdej wiadomości). Mikrofon działa tylko w trakcie nagrywania.</p>

{#if !providers.length}
  <div class="form">
    <p class="hint" style="margin:0">Do dyktowania potrzebny jest provider <b>OpenAI</b> albo <b>zgodny z OpenAI</b> z kluczem API, np. Groq (<code>https://api.groq.com/openai/v1</code>, szybki Whisper z darmowym limitem) albo lokalny serwer Whisper. Czytanie głosami Windows działa bez niego.</p>
    <div><button class="btn" onclick={() => (ui.settingsPage = 'providers')}><Icon name="key" />Konta i providerzy</button></div>
  </div>
{/if}

<h3>Dyktowanie</h3>
<div class="grid2">
  <div class="field"><label for="vSttP">Provider</label>
    <select class="inp" id="vSttP" value={stt?.id || ''} disabled={!providers.length} onchange={(e) => { app.voice.sttProvider = e.currentTarget.value; app.voice.sttModel = ''; }}>
      {#each providers as p}<option value={p.id}>{p.name}</option>{:else}<option value="">brak</option>{/each}
    </select></div>
  <div class="field"><label for="vSttM">Model</label>
    <input class="inp mono" id="vSttM" list="vSttMl" bind:value={app.voice.sttModel} placeholder={defaultSttModel(stt) || 'whisper-1'} spellcheck="false" />
    <datalist id="vSttMl">{#each STT_MODELS as m}<option value={m}></option>{/each}</datalist></div>
  <div class="field"><label for="vLang">Język nagrań</label>
    <select class="inp" id="vLang" bind:value={app.voice.lang}>{#each LANGS as [k, v]}<option value={k}>{v}</option>{/each}</select>
    <small>Podany język poprawia trafność i szybkość.</small></div>
</div>
<div class="field">
  <label class="checks"><input type="checkbox" bind:checked={app.voice.autoSend} />Wysyłaj od razu po nagraniu</label>
  <small>Wyłączone: rozpoznany tekst trafia do pola wiadomości, żeby go poprawić przed wysłaniem.</small>
</div>
<div class="field">
  <label class="checks"><input type="checkbox" bind:checked={app.voice.keepAudio} />Zachowaj nagranie w rozmowie</label>
  <small>Plik dołącza się do wiadomości (do odsłuchania w historii). Model dostaje tylko rozpoznany tekst.</small>
</div>

<h3>Czytanie odpowiedzi</h3>
<div class="grid2">
  <div class="field"><label for="vSpeak">Czytaj na głos</label>
    <select class="inp" id="vSpeak" bind:value={app.voice.speak}>
      <option value="off">Nie (tylko na żądanie)</option>
      <option value="agent">Odpowiedzi agenta</option>
      <option value="all">Agent i podagenci</option>
    </select></div>
  <div class="field"><span class="flabel">Głos</span>
    <div class="seg">
      <button class:on={app.voice.engine === 'system'} onclick={() => (app.voice.engine = 'system')}>Windows (offline)</button>
      <button class:on={app.voice.engine === 'provider'} onclick={() => (app.voice.engine = 'provider')}>Provider</button>
    </div></div>
</div>

{#if app.voice.engine === 'system'}
  <div class="grid2">
    <div class="field"><label for="vSys">Głos systemu</label>
      <select class="inp" id="vSys" bind:value={app.voice.sysVoice}>
        <option value="">Automatycznie (język aplikacji)</option>
        {#each sorted as v}<option value={v.name}>{v.name} · {v.lang}</option>{/each}
      </select>
      {#if voices.length && !voices.some((v) => v.lang.startsWith('pl'))}<small>Brak polskiego głosu: dodaj pakiet mowy w Ustawienia Windows → Czas i język → Mowa.</small>{/if}</div>
    <div class="field"><label for="vRate">Tempo: {app.voice.rate.toFixed(1)}×</label>
      <input type="range" id="vRate" min="0.6" max="2" step="0.1" bind:value={app.voice.rate} /></div>
  </div>
{:else}
  <div class="grid2">
    <div class="field"><label for="vTtsP">Provider</label>
      <select class="inp" id="vTtsP" value={tts?.id || ''} disabled={!providers.length} onchange={(e) => (app.voice.ttsProvider = e.currentTarget.value)}>
        {#each providers as p}<option value={p.id}>{p.name}</option>{:else}<option value="">brak</option>{/each}
      </select></div>
    <div class="field"><label for="vTtsM">Model</label>
      <input class="inp mono" id="vTtsM" list="vTtsMl" bind:value={app.voice.ttsModel} placeholder="gpt-4o-mini-tts" spellcheck="false" />
      <datalist id="vTtsMl">{#each TTS_MODELS as m}<option value={m}></option>{/each}</datalist></div>
    <div class="field"><label for="vTtsV">Głos</label>
      <input class="inp mono" id="vTtsV" list="vTtsVl" bind:value={app.voice.ttsVoice} placeholder="coral" spellcheck="false" />
      <datalist id="vTtsVl">{#each TTS_VOICES as m}<option value={m}></option>{/each}</datalist></div>
    <div class="field"><label for="vTtsS">Sposób mówienia (opcjonalnie)</label>
      <input class="inp" id="vTtsS" bind:value={app.voice.ttsStyle} placeholder="np. spokojnie, rzeczowo, po polsku" /></div>
  </div>
  <small class="hint">Płatne według cennika providera. Długie odpowiedzi są czytane w kawałkach; kod jest pomijany.</small>
{/if}
<div><button class="btn" onclick={test}><Icon name={testing ? 'stop' : 'volume'} />{testing ? 'Zatrzymaj' : 'Odsłuchaj próbkę'}</button></div>

<style>
  .mono { font-family: var(--font-mono); font-size: 12px; }
  h3 { margin-top: 4px !important; }
</style>
