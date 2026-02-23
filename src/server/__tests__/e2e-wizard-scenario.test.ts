/**
 * E2E Scenario 4: Multi-step wizard with forms on each step.
 *
 * Flow:
 *   1. Jane creates a 3-step wizard canvas (tabs with forms on each step)
 *   2. User fills out Step 1 form fields
 *   3. User clicks "Next" → Jane receives callback, updates activeTab to step 2
 *   4. User fills out Step 2 form fields
 *   5. User clicks "Next" → Jane receives callback, updates activeTab to step 3
 *   6. User can go "Back" to step 2 → Jane updates activeTab back
 *   7. User returns to step 3 and clicks "Submit"
 *   8. Jane reads aggregated form data from all 3 steps
 *
 * Success criteria:
 *   - Wizard navigation works (next/back buttons via callback events)
 *   - Each step preserves its state across navigation
 *   - Final submission includes data from all steps
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from './test-db.js';
import type { DbClient } from '../db.js';
import { createCanvasesRouter } from '../routes/canvases.js';

// ─── Test setup ──────────────────────────────────────────────────────────────

function createTestApp(db: DbClient): Hono {
  const app = new Hono();
  app.route('/api/canvases', createCanvasesRouter(db));
  return app;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ─── Wizard descriptor: 3-step registration ─────────────────────────────────

const wizardDescriptor = {
  title: 'Registration Wizard',
  components: [
    {
      id: 'wizard-tabs',
      type: 'tabs',
      props: {
        activeTab: 'step1',
        variant: 'underline',
        tabs: [
          {
            id: 'step1',
            label: '1. Personal Info',
            children: [
              {
                id: 'step1-form',
                type: 'form',
                props: { validateOnBlur: true },
                children: [
                  {
                    id: 'field-fullname',
                    type: 'input',
                    props: {
                      name: 'fullName',
                      label: 'Full Name',
                      required: true,
                      inputType: 'text',
                      placeholder: 'Enter your full name',
                    },
                  },
                  {
                    id: 'field-email',
                    type: 'input',
                    props: {
                      name: 'email',
                      label: 'Email',
                      required: true,
                      inputType: 'email',
                      placeholder: 'you@example.com',
                    },
                  },
                  {
                    id: 'field-age',
                    type: 'input',
                    props: {
                      name: 'age',
                      label: 'Age',
                      inputType: 'number',
                    },
                  },
                ],
              },
              {
                id: 'step1-next-btn',
                type: 'button',
                props: { label: 'Next →', variant: 'primary' },
                events: [
                  {
                    type: 'click',
                    action: {
                      type: 'callback',
                      callbackId: 'wizardNext',
                      payload: { currentStep: 'step1', nextStep: 'step2' },
                    },
                  },
                ],
              },
            ],
          },
          {
            id: 'step2',
            label: '2. Preferences',
            children: [
              {
                id: 'step2-form',
                type: 'form',
                props: { validateOnBlur: true },
                children: [
                  {
                    id: 'field-theme',
                    type: 'select',
                    props: {
                      name: 'theme',
                      label: 'Theme',
                      required: true,
                      options: [
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'system', label: 'System' },
                      ],
                    },
                  },
                  {
                    id: 'field-notifications',
                    type: 'toggle',
                    props: {
                      name: 'notifications',
                      label: 'Enable Notifications',
                    },
                  },
                  {
                    id: 'field-language',
                    type: 'select',
                    props: {
                      name: 'language',
                      label: 'Language',
                      required: true,
                      options: [
                        { value: 'en', label: 'English' },
                        { value: 'es', label: 'Spanish' },
                        { value: 'fr', label: 'French' },
                      ],
                    },
                  },
                ],
              },
              {
                id: 'step2-nav',
                type: 'container',
                props: { direction: 'row', gap: '12px' },
                children: [
                  {
                    id: 'step2-back-btn',
                    type: 'button',
                    props: { label: '← Back', variant: 'outline' },
                    events: [
                      {
                        type: 'click',
                        action: {
                          type: 'callback',
                          callbackId: 'wizardBack',
                          payload: { currentStep: 'step2', nextStep: 'step1' },
                        },
                      },
                    ],
                  },
                  {
                    id: 'step2-next-btn',
                    type: 'button',
                    props: { label: 'Next →', variant: 'primary' },
                    events: [
                      {
                        type: 'click',
                        action: {
                          type: 'callback',
                          callbackId: 'wizardNext',
                          payload: { currentStep: 'step2', nextStep: 'step3' },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: 'step3',
            label: '3. Confirmation',
            children: [
              {
                id: 'step3-form',
                type: 'form',
                props: { validateOnBlur: true },
                children: [
                  {
                    id: 'field-agree-terms',
                    type: 'checkbox',
                    props: {
                      name: 'agreeTerms',
                      label: 'I agree to the Terms of Service',
                      required: true,
                    },
                  },
                  {
                    id: 'field-comments',
                    type: 'textarea',
                    props: {
                      name: 'comments',
                      label: 'Additional Comments',
                      placeholder: 'Anything else you would like to share?',
                      rows: 3,
                    },
                  },
                ],
              },
              {
                id: 'step3-nav',
                type: 'container',
                props: { direction: 'row', gap: '12px' },
                children: [
                  {
                    id: 'step3-back-btn',
                    type: 'button',
                    props: { label: '← Back', variant: 'outline' },
                    events: [
                      {
                        type: 'click',
                        action: {
                          type: 'callback',
                          callbackId: 'wizardBack',
                          payload: { currentStep: 'step3', nextStep: 'step2' },
                        },
                      },
                    ],
                  },
                  {
                    id: 'step3-submit-btn',
                    type: 'button',
                    props: { label: 'Submit Registration', variant: 'primary' },
                    events: [
                      {
                        type: 'click',
                        action: {
                          type: 'callback',
                          callbackId: 'wizardSubmit',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ],
};

// ─── E2E Test ────────────────────────────────────────────────────────────────

describe('E2E Scenario 4: Multi-step wizard with aggregated form data', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Hono;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(async () => {
    await db.cleanup();
  });

  it('full flow: create wizard → fill 3 steps → navigate back/forward → submit → Jane reads aggregated data', async () => {
    // ── Step 1: Jane creates the wizard canvas ────────────────────────────

    const createRes = await req(app, 'POST', '/api/canvases', wizardDescriptor);
    expect(createRes.status).toBe(201);

    const canvas = await createRes.json();
    expect(canvas.id).toBeDefined();
    expect(canvas.title).toBe('Registration Wizard');

    const canvasId = canvas.id;

    // Verify initial tab is step1
    const initialGet = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const initialCanvas = await initialGet.json();
    const tabsComponent = initialCanvas.descriptor.components[0];
    expect(tabsComponent.props.activeTab).toBe('step1');

    // ── Step 2: User fills out Step 1 (Personal Info) ─────────────────────

    const nameRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-fullname',
      eventType: 'change',
      value: 'Jane Doe',
    });
    expect(nameRes.status).toBe(201);

    const emailRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-email',
      eventType: 'change',
      value: 'jane@example.com',
    });
    expect(emailRes.status).toBe(201);

    const ageRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-age',
      eventType: 'change',
      value: 28,
    });
    expect(ageRes.status).toBe(201);

    // ── Step 3: User clicks "Next" on Step 1 ─────────────────────────────

    const nextStep1Res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step1-next-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardNext', payload: { currentStep: 'step1', nextStep: 'step2' } },
    });
    expect(nextStep1Res.status).toBe(201);

    // Jane polls for the callback and receives navigation request
    const pendingStep1 = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingStep1Body = await pendingStep1.json();
    expect(pendingStep1Body.events.length).toBeGreaterThanOrEqual(1);

    const navEvent1 = pendingStep1Body.events.find(
      (e: any) => e.payload.componentId === 'step1-next-btn'
    );
    expect(navEvent1).toBeDefined();
    expect(navEvent1.payload.metadata.callbackId).toBe('wizardNext');

    // Jane acknowledges and navigates to step 2 by updating activeTab
    await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${navEvent1.id}/acknowledge`
    );

    const patchStep2Res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/wizard-tabs`,
      { props: { activeTab: 'step2' } }
    );
    expect(patchStep2Res.status).toBe(200);

    // Verify the tab was updated
    const afterPatch1 = await req(app, 'GET', `/api/canvases/${canvasId}`);
    const afterPatch1Body = await afterPatch1.json();
    expect(afterPatch1Body.descriptor.components[0].props.activeTab).toBe('step2');

    // ── Step 4: User fills out Step 2 (Preferences) ──────────────────────

    const themeRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-theme',
      eventType: 'change',
      value: 'dark',
    });
    expect(themeRes.status).toBe(201);

    const notifRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-notifications',
      eventType: 'change',
      value: true,
    });
    expect(notifRes.status).toBe(201);

    const langRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-language',
      eventType: 'change',
      value: 'es',
    });
    expect(langRes.status).toBe(201);

    // ── Step 5: User clicks "Next" on Step 2 → go to Step 3 ──────────────

    const nextStep2Res = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step2-next-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardNext', payload: { currentStep: 'step2', nextStep: 'step3' } },
    });
    expect(nextStep2Res.status).toBe(201);

    // Jane polls and navigates to step 3
    const pendingStep2 = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingStep2Body = await pendingStep2.json();
    const navEvent2 = pendingStep2Body.events.find(
      (e: any) => e.payload.componentId === 'step2-next-btn'
    );
    expect(navEvent2).toBeDefined();

    await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${navEvent2.id}/acknowledge`
    );

    const patchStep3Res = await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/wizard-tabs`,
      { props: { activeTab: 'step3' } }
    );
    expect(patchStep3Res.status).toBe(200);

    // ── Step 6: User goes Back from Step 3 → Step 2 ──────────────────────

    const backRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step3-back-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardBack', payload: { currentStep: 'step3', nextStep: 'step2' } },
    });
    expect(backRes.status).toBe(201);

    // Jane processes back navigation
    const pendingBack = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingBackBody = await pendingBack.json();
    const backEvent = pendingBackBody.events.find(
      (e: any) => e.payload.componentId === 'step3-back-btn'
    );
    expect(backEvent).toBeDefined();
    expect(backEvent.payload.metadata.callbackId).toBe('wizardBack');

    await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${backEvent.id}/acknowledge`
    );

    await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/wizard-tabs`,
      { props: { activeTab: 'step2' } }
    );

    // Verify Step 2 state is preserved after navigating away and back
    const step2StateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const step2Snapshot = await step2StateRes.json();

    expect(step2Snapshot.components['field-theme'].value).toBe('dark');
    expect(step2Snapshot.components['field-notifications'].value).toBe(true);
    expect(step2Snapshot.components['field-language'].value).toBe('es');

    // Also verify Step 1 state is still preserved
    expect(step2Snapshot.components['field-fullname'].value).toBe('Jane Doe');
    expect(step2Snapshot.components['field-email'].value).toBe('jane@example.com');
    expect(step2Snapshot.components['field-age'].value).toBe(28);

    // ── Step 7: User navigates forward to Step 3 again ────────────────────

    const nextAgainRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step2-next-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardNext', payload: { currentStep: 'step2', nextStep: 'step3' } },
    });
    expect(nextAgainRes.status).toBe(201);

    // Jane navigates forward
    const pendingFwd = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingFwdBody = await pendingFwd.json();
    const fwdEvent = pendingFwdBody.events.find(
      (e: any) => e.payload.componentId === 'step2-next-btn'
    );
    await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${fwdEvent.id}/acknowledge`
    );

    await req(
      app,
      'PATCH',
      `/api/canvases/${canvasId}/components/wizard-tabs`,
      { props: { activeTab: 'step3' } }
    );

    // ── Step 8: User fills out Step 3 (Confirmation) ──────────────────────

    const termsRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-agree-terms',
      eventType: 'change',
      value: true,
    });
    expect(termsRes.status).toBe(201);

    const commentsRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-comments',
      eventType: 'change',
      value: 'Looking forward to using the platform!',
    });
    expect(commentsRes.status).toBe(201);

    // ── Step 9: User clicks "Submit Registration" ─────────────────────────

    const submitRes = await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step3-submit-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardSubmit' },
    });
    expect(submitRes.status).toBe(201);

    // Jane polls for the submission event
    const pendingSubmit = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingSubmitBody = await pendingSubmit.json();
    const submitEvent = pendingSubmitBody.events.find(
      (e: any) => e.payload.componentId === 'step3-submit-btn'
    );
    expect(submitEvent).toBeDefined();
    expect(submitEvent.payload.metadata.callbackId).toBe('wizardSubmit');

    // Jane acknowledges the submit
    const ackSubmitRes = await req(
      app,
      'POST',
      `/api/canvases/${canvasId}/events/${submitEvent.id}/acknowledge`
    );
    expect(ackSubmitRes.status).toBe(200);

    // ── Step 10: Jane reads aggregated form data from all 3 steps ─────────

    const finalStateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    expect(finalStateRes.status).toBe(200);

    const finalSnapshot = await finalStateRes.json();

    // Step 1 fields — Personal Info
    expect(finalSnapshot.components['field-fullname']).toBeDefined();
    expect(finalSnapshot.components['field-fullname'].value).toBe('Jane Doe');
    expect(finalSnapshot.components['field-email']).toBeDefined();
    expect(finalSnapshot.components['field-email'].value).toBe('jane@example.com');
    expect(finalSnapshot.components['field-age']).toBeDefined();
    expect(finalSnapshot.components['field-age'].value).toBe(28);

    // Step 2 fields — Preferences
    expect(finalSnapshot.components['field-theme']).toBeDefined();
    expect(finalSnapshot.components['field-theme'].value).toBe('dark');
    expect(finalSnapshot.components['field-notifications']).toBeDefined();
    expect(finalSnapshot.components['field-notifications'].value).toBe(true);
    expect(finalSnapshot.components['field-language']).toBeDefined();
    expect(finalSnapshot.components['field-language'].value).toBe('es');

    // Step 3 fields — Confirmation
    expect(finalSnapshot.components['field-agree-terms']).toBeDefined();
    expect(finalSnapshot.components['field-agree-terms'].value).toBe(true);
    expect(finalSnapshot.components['field-comments']).toBeDefined();
    expect(finalSnapshot.components['field-comments'].value).toBe(
      'Looking forward to using the platform!'
    );

    // Verify form validity for all three step forms
    expect(finalSnapshot.formValidity['step1-form']).toBe(true);
    expect(finalSnapshot.formValidity['step2-form']).toBe(true);
    expect(finalSnapshot.formValidity['step3-form']).toBe(true);

    // Verify no more pending click events
    const pendingFinalRes = await req(
      app,
      'GET',
      `/api/canvases/${canvasId}/events/pending?eventType=click`
    );
    const pendingFinal = await pendingFinalRes.json();
    expect(pendingFinal.events.length).toBe(0);
  });

  it('wizard navigation preserves state: fill step 1, go to step 2, go back, step 1 data intact', async () => {
    // Create the wizard
    const createRes = await req(app, 'POST', '/api/canvases', wizardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Fill step 1
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-fullname',
      eventType: 'change',
      value: 'Bob Builder',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-email',
      eventType: 'change',
      value: 'bob@example.com',
    });

    // Navigate to step 2
    await req(app, 'PATCH', `/api/canvases/${canvasId}/components/wizard-tabs`, {
      props: { activeTab: 'step2' },
    });

    // Fill step 2
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-theme',
      eventType: 'change',
      value: 'light',
    });

    // Navigate back to step 1
    await req(app, 'PATCH', `/api/canvases/${canvasId}/components/wizard-tabs`, {
      props: { activeTab: 'step1' },
    });

    // Verify both step 1 and step 2 data are preserved
    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const snapshot = await stateRes.json();

    // Step 1 data should still be there
    expect(snapshot.components['field-fullname'].value).toBe('Bob Builder');
    expect(snapshot.components['field-email'].value).toBe('bob@example.com');

    // Step 2 data should also be preserved
    expect(snapshot.components['field-theme'].value).toBe('light');
  });

  it('form validity is tracked per-step independently', async () => {
    // Create the wizard
    const createRes = await req(app, 'POST', '/api/canvases', wizardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Fill only some required fields in step 1 (fullName but not email)
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-fullname',
      eventType: 'change',
      value: 'Partial User',
    });

    // Fill all required fields in step 2
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-theme',
      eventType: 'change',
      value: 'dark',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-language',
      eventType: 'change',
      value: 'fr',
    });

    // Read state — step 1 form should be invalid (missing email), step 2 should be valid
    const stateRes = await req(app, 'GET', `/api/canvases/${canvasId}/state`);
    const snapshot = await stateRes.json();

    expect(snapshot.formValidity['step1-form']).toBe(false); // email required but not filled
    expect(snapshot.formValidity['step2-form']).toBe(true);  // theme and language both filled
  });

  it('event history captures all navigation and form events across steps', async () => {
    // Create the wizard
    const createRes = await req(app, 'POST', '/api/canvases', wizardDescriptor);
    const canvas = await createRes.json();
    const canvasId = canvas.id;

    // Step 1: fill name and click next
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-fullname',
      eventType: 'change',
      value: 'Alice',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step1-next-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardNext' },
    });

    // Step 2: fill theme and click next
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-theme',
      eventType: 'change',
      value: 'dark',
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step2-next-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardNext' },
    });

    // Step 3: accept terms and submit
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'field-agree-terms',
      eventType: 'change',
      value: true,
    });
    await req(app, 'POST', `/api/canvases/${canvasId}/actions`, {
      componentId: 'step3-submit-btn',
      eventType: 'click',
      metadata: { callbackId: 'wizardSubmit' },
    });

    // Read event history
    const eventsRes = await req(app, 'GET', `/api/canvases/${canvasId}/events`);
    expect(eventsRes.status).toBe(200);

    const history = await eventsRes.json();
    expect(history.events.length).toBe(6);

    // Events are newest-first
    expect(history.events[0].payload.componentId).toBe('step3-submit-btn');
    expect(history.events[0].eventType).toBe('click');
    expect(history.events[5].payload.componentId).toBe('field-fullname');
    expect(history.events[5].eventType).toBe('change');
  });
});
