/**
 * The provider's plan, as metrics.
 *
 * The plan is the limit the queue obeys: the Token Plan publishes how much
 * of each of its windows is left, and the queue stops when there is no
 * room. That number is the one an operator needs, and it has to be
 * visible where the rest of the numbers are — not only in the settings
 * screen.
 *
 * So the plan is published as four metrics:
 *
 *   foldergram.ai.plan.remaining        how much of the window is left, in %
 *   foldergram.ai.plan.time_left        how long it lasts at the current rate
 *   foldergram.ai.plan.rolls_over_in    how long until the window rolls over
 *   foldergram.ai.plan.contended        whether somebody else is in the pool
 *   foldergram.ai.plan.room_ratio       how much faster it could be spent
 *
 * They live in their own module because the plan is the AI plugin's
 * business, and because this file must not depend on anything else the
 * observability code touches.
 *
 * The counters are up-down ones: the value is the current state, not a
 * growing total. Publishing an absolute value means publishing the
 * difference with the last one, which is what the helper below does.
 */

import { metrics, type Attributes } from '@opentelemetry/api';

const SCOPE_NAME = 'foldergram';

/** One of the plan's windows, as it is published. */
export interface PlanWindowSample {
  /** Which window this is: the plan's interval, or its week. */
  readonly kind: string;
  /** How much of the window is left, as a percentage. */
  readonly remainingPercent: number;
  /** How long the window lasts at the rate it is being spent, in hours. */
  readonly hoursLeft: number | null;
  /** How long until the window rolls over, in seconds. */
  readonly rollsOverInSeconds: number;
}

/** The state of one provider's plan. */
export interface PlanStateSample {
  /** The provider the plan belongs to. */
  readonly providerId: string;
  /** Every window the plan publishes. */
  readonly windows: readonly PlanWindowSample[];
  /** Somebody else is using the plan. */
  readonly contended: boolean;
  /**
   * How much faster the plan could be spent before a window runs out
   * before it renews. Above one there is room to spare.
   */
  readonly roomRatio: number | null;
}

interface PlanInstruments {
  remaining: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
  timeLeft: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
  rollsOverIn: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
  contended: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
  roomRatio: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
}

let instruments: PlanInstruments | null = null;
let instrumentsProvider: unknown = null;

/** The last value published for each series, to turn it into a delta. */
const lastValues = new Map<string, number>();

function getInstruments(): PlanInstruments {
  const provider = metrics.getMeterProvider();

  // The instruments are bound to the provider that was active when they
  // were created. If the provider is replaced, they have to be created
  // again, or they would keep reporting to a provider nobody reads.
  if (instruments && instrumentsProvider === provider) {
    return instruments;
  }

  const meter = metrics.getMeter(SCOPE_NAME);

  instruments = {
    remaining: meter.createUpDownCounter('foldergram.ai.plan.remaining', {
      description: 'How much of the plan window is left, as a percentage',
      unit: '%'
    }),
    timeLeft: meter.createUpDownCounter('foldergram.ai.plan.time_left', {
      description: 'How long the plan window lasts at the rate it is being spent',
      unit: 'h'
    }),
    rollsOverIn: meter.createUpDownCounter('foldergram.ai.plan.rolls_over_in', {
      description: 'How long until the plan window rolls over',
      unit: 's'
    }),
    contended: meter.createUpDownCounter('foldergram.ai.plan.contended', {
      description: 'Whether somebody else is using the plan (1) or not (0)'
    }),
    roomRatio: meter.createUpDownCounter('foldergram.ai.plan.room_ratio', {
      description:
        'How much faster the plan could be spent before a window runs out before it renews'
    })
  };
  instrumentsProvider = provider;
  // A new provider starts from zero, so the delta that brings a counter
  // back to the real value is computed against zero.
  lastValues.clear();

  return instruments;
}

/**
 * Publishes an absolute value as the difference with the last one.
 *
 * An up-down counter accumulates, so publishing the value itself would
 * grow without bound. What the backend sees is the sum of the deltas,
 * which is the value.
 */
function publish(
  counter: PlanInstruments[keyof PlanInstruments],
  key: string,
  value: number,
  attributes: Attributes
): void {
  const previous = lastValues.get(key);
  const delta = value - (previous ?? 0);

  // Nothing changed, so there is nothing to publish — except the very
  // first time: a series that was never published does not exist, and a
  // state of "no" that is missing cannot be told apart from "no idea".
  if (previous !== undefined && delta === 0) {
    return;
  }

  counter.add(delta, attributes);
  lastValues.set(key, value);
}

/**
 * Publishes the state of a provider's plan.
 *
 * The plan is read every couple of minutes, so the numbers change slowly
 * and each publish is a small delta.
 */
export function recordPlanState(sample: PlanStateSample): void {
  try {
    const { remaining, timeLeft, rollsOverIn, contended, roomRatio } =
      getInstruments();
    const provider = sample.providerId || 'unknown';

    for (const window of sample.windows) {
      const labels: Attributes = { provider, window: window.kind };

      publish(remaining, `remaining:${provider}:${window.kind}`, window.remainingPercent, labels);
      publish(
        rollsOverIn,
        `rollsOverIn:${provider}:${window.kind}`,
        window.rollsOverInSeconds,
        labels
      );

      // The projection is null when the plan is not being spent, or when
      // there is not enough history to tell how fast it goes. Nothing is
      // published then: there is no number to publish.
      if (window.hoursLeft !== null && Number.isFinite(window.hoursLeft)) {
        publish(timeLeft, `timeLeft:${provider}:${window.kind}`, window.hoursLeft, labels);
      }
    }

    publish(contended, `contended:${provider}`, sample.contended ? 1 : 0, { provider });

    // How much faster the plan could be spent. Null when the plan could
    // not be read, or when there is not enough signal to say.
    if (sample.roomRatio !== null && Number.isFinite(sample.roomRatio)) {
      publish(roomRatio, `roomRatio:${provider}`, sample.roomRatio, { provider });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[telemetry] could not publish the plan state: ${message}`);
  }
}

/** Forgets the published values. Used by the tests. */
export function resetPlanMetrics(): void {
  lastValues.clear();
}
