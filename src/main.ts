import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { app as state, ui } from './lib/state.svelte';
import * as sessions from './lib/terminal/sessions.svelte';
import { remote } from './lib/remote.svelte';
import { flowRun } from './lib/workflow/engine.svelte';
import * as comfy from './lib/workflow/comfy.svelte';
import * as agent from './lib/agent.svelte';
import * as accounts from './lib/accounts';

const app = mount(App, { target: document.getElementById('app')! });

// Uchwyt diagnostyczny (konsola DevTools, testy end-to-end). Pluginy go nie widzą: działają w izolowanych iframe.
(window as any).__tx = { state, ui, sessions, remote, flowRun, comfy, agent, accounts };

export default app;
