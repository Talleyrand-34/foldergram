# Proposal: using the whole plan

## The problem

The plan is barely being used while the backlog is huge, and the reason is
not the one it looks like.

At the time of writing, on the production host (CT 144):

| | |
| --- | --- |
| The five-hour window | **95 % left**, renewing in 50 minutes |
| The weekly window | 60 % left, renewing in 98 hours |
| The queue | 36.994 posts pending (4.125 fewer than the day before) |
| Throughput | 4.4 to 7 analyses per minute |
| Median analysis | 14.5 s (p95 32 s) |
| The container's CPU | **86.6 % idle**, 6 cores |
| The provider's rate limits | no 429s at all - it is not the one holding us back |

The five-hour window is the one that hurts. Its allowance is roughly
**116 million tokens** (the plan dropped 5 points while we spent 5.8
million), and we spend about **1.4 million tokens an hour**. So we use
5 % of it and the other 95 % is thrown away when the window renews, every
five hours, all day long.

Meanwhile the weekly window - a separate allowance, which does not carry
over either - is at 60 % with 98 hours to run. At the current pace the
week would finish with roughly a third of it unused.

So the plan is not the limit. **The application is.**

## Where the throughput is lost

Three things, in the order they cost us:

### 1. The parallelism works in batches, not as a pool

The worker starts three analyses, waits for all three, and only then starts
the next three. The slowest of the batch holds the other two hostage:

```
12:49:56  processing 55027  55028  55029
12:50:07  done 55029 (11.1 s)
12:50:10  done 55027 (12.7 s)
12:50:12  done 55028 (14.4 s)
12:50:15  processing 55032  55033  55034      <- the next batch
12:50:25  done 55034 (9.5 s)
12:50:27  done 55033 (11.8 s)
12:50:39  done 55032 (23.6 s)                 <- the batch took 24 s
```

Three analyses every twenty-five seconds is 7 per minute. A pool that
refills a slot the moment it frees would give **3 / 12 s = 15 per minute**
with the same three workers and the same plan usage.

This is the cheapest win there is: it costs no extra plan, no extra CPU
and no extra risk.

### 2. The ceiling of three is a magic number

The number of workers at the same time is decided by the room the plan
leaves - and the plan leaves a lot:

```
foldergram_ai_plan_room_ratio = 94
foldergram_ai_analysis_concurrency = 3      <- the cap, not the room
```

The room says "up to ninety-four times faster". The cap says three. The
cap is what binds, and it was picked as a conservative default.

The machine can take it: an analysis spends about **5.8 s of CPU** (the
frame and audio extraction) and the rest is waiting for the model. Six
cores at 86 % idle is room for six to eight workers without the CPU
becoming the limit. And the provider is not rate-limiting us.

### 3. The pace does not follow the perishable window

The five-hour allowance is the one that gets thrown away. It should be the
one that decides the pace, and it should be spent **before the window
renews**, not spread evenly and lost.

What the current rule does: the window that renews soonest sets the pace,
the other one is a brake, and the number of workers is
`round(room ratio)`. The room ratio of the five-hour window is measured
against the drain since the window opened - and a window that opened twenty
minutes ago has a tiny drain, so the ratio is huge and the cap takes over.
It works, but by accident: the ratio is high because the window is young,
not because there is room.

## The proposal

### A. A pool of workers, not a batch

Keep N workers alive, each pulling the next video from the queue as soon
as it is free. The queue is already able to hand out several videos at
once (`claimNextPending` claims one row per call, and the calls are
sequential), so this is a change of shape, not of machinery.

Expected: **7 to 15 analyses per minute** with the same three workers and
the same plan usage. The plan usage is unchanged, so this cannot make the
plan run out earlier - it just stops wasting the application's own work.

### B. The number of workers comes from the room, not from a magic number

```
workers = clamp(ceil(room ratio), 1, the machine's spare cores)
```

and the cap becomes a property of the machine rather than a constant. The
room ratio is 94, so the cap would be whatever the box can take - six
cores, 5.8 s of CPU per analysis, mostly waiting: **six to eight workers**.

`AI_ANALYSIS_MAX_PARALLEL` stays as the override.

### C. The ramp: the pace that uses the window before it renews

This is the part that answers "use it at the limits when the interval
time is finishing".

For a window with `R` percent left and `T` hours of life, the rate that
empties it exactly on time is:

```
the rate to empty it on time = R / T        (percentage points an hour)
```

`R` falls as the window is spent, and `T` falls as the window runs out.
So:

- at the beginning of a window, `R/T` is the steady rate that uses the
  whole allowance;
- if we have been slower than that, the catch-up rate `R/T` **grows as
  `1/T`** - which is the ramp: the closer the window is to its end, the
  harder the queue has to work to avoid losing what is left.

The workers needed for a rate are then:

```
workers = the rate to empty it on time / the rate of one worker
```

where the rate of one worker is measured, not assumed: the tokens an
analysis spends, divided by how long it takes, divided by the tokens the
plan counts per point.

The ramp is bounded twice:

- by the machine (the spare cores), and
- by the weekly window, which is the real budget.

### D. The brake: the weekly window, measured with our own consumption

The weekly window is the allowance that actually has to last the week, so
it is the cap. But its percentage cannot be converted into tokens: the
server's accounting for the weekly is not proportional to what we spend
(the same 30.7 million tokens appear as 40 points in the weekly and as 5
points in the five-hour window, which cannot both be right). So the weekly
percentage is only usable as a coarse brake, not as a budget.

The brake that does work is built from our own consumption:

```
the tokens we spend in the weekly window / the points it has dropped
  = the tokens the plan counts per point  (a lower bound: if somebody
    else is on the plan, the real scale is bigger, and a bigger scale
    means we think we spend more points per token, so we think we have
    less room - which is the safe direction)
```

With that scale, the sustainable rate of the weekly window is:

```
the points it has left / the hours it has left
```

and the workers are capped so the queue does not go past it.

### E. The shared plan

The weekly drain includes the other user - about 94 % of it, by the
measurements. Their consumption is not ours to slow down and not ours to
count. So:

- the five-hour window's scale is ours (we are the only consumer of it at
  the moment), and it is the one that decides the pace;
- the weekly is a brake, computed on our share of the drain, not on the
  plan's total;
- the contention flag stays as it is: the plan moves while we send nothing.

## What it would look like

| | now | with the proposal |
| --- | --- | --- |
| Analyses per minute | 4.4 - 7 | 15 - 30 |
| The five-hour window at the renewal | 95 % unused | close to 0 % |
| The weekly window at the renewal | ~30 % unused | whatever the weekly allows |
| The backlog | 36.994 | ~20.000 a week instead of ~7.000 |
| CPU | 86 % idle | ~50 % idle |
| The plan's 429s | none | watch for them |

The backlog is the point: at 15 to 30 per minute it is about 21.000 to
43.000 posts a week, which is the scale at which the plan's weekly
allowance becomes the real limit and the queue stops for a reason that
makes sense.

## The risks, and what bounds them

| Risk | Bound |
| --- | --- |
| The provider rate-limits us (429) | The worker already pauses on a 429 and the pause is published as a metric. The ramp would back off on its own: the pause lowers the drain and the room grows again. |
| The CPU saturates | The cap is the machine's spare cores, and the CPU is published. |
| The plan runs out early | The weekly brake, computed on our own share, is exactly what stops it. |
| The other user needs the plan | Their share is never counted as ours; the five-hour window is the one we take, and only what is left of it. |
| A window with no history | The ramp needs the drain since the window opened; with less than fifteen minutes of it, the queue keeps the current pace. |

## What would have to be measured to be sure

Two things are not settled, and both are measurable in an afternoon:

1. **The scale of the weekly window.** The numbers above say the weekly
   allowance is roughly 3.4 times the five-hour one, but the two
   measurements disagree by a factor of two. The proposal does not depend
   on the exact figure - the brake is computed from our own consumption,
   which is known exactly - but the projection does.
2. **The five-hour window's allowance in tokens.** It is read off one
   window's drain (116 million tokens), which assumes we were its only
   consumer. The contention flag says we were, but the flag is a coarse
   signal.

Both are answered by the same thing: a couple of days of the plan's
readings next to our own token counts, which the telemetry already keeps.

## What has been done already, and what it measured

Three of the steps are implemented and measured on the production host.

### The pool instead of the batch - done

A pool of workers, not a batch: a worker that finishes takes the next
video at once. The measurements:

| | before | after |
| --- | --- | --- |
| Analyses per minute | 4.4 - 7 | 16 - 32 |
| Median analysis | 14.5 s | 7 - 11 s |

### The database was the real bottleneck - done

The profiling dashboard (`foldergram-profiling`) pointed at the database:
`images` was eating 1.6 seconds of query time per second, and the updates
the AI pipeline does on every analysis took 710 ms each.

Two causes:

1. **The cache was the default.** `shared_buffers` was 160 MB for a
   511 MB database on a machine with 13 GB free. Every random read was a
   disk read, and the disk here has a random latency of about 145 ms. With
   the database in memory the same `UPDATE` takes 4 ms.
2. **The table has 34 indexes.** A change to `ai_status` is not a HOT
   update, so every `UPDATE` rewrites the row's 34 index entries: 41
   buffers, 330 KB of random writes, for a row that changes two columns.

The first is fixed (`docs/deployment.md` has the settings). The second is
the next piece of work, and it is the biggest one left: moving the AI
status out of `images` into its own small table would make those updates
HOT, and the plan's cost would fall by a factor of eight.

### The ramp - done, with the brake

The workers walk towards what the room allows: with two workers and a room
of two and a half, five would fit. They move one step at a time, because
the room is measured against the current consumption and going straight to
the target overshoots.

The room is smoothed before it is used: the plan publishes whole
percentages, so the raw ratio wanders by a few tenths and the queue would
change the number of workers every few minutes for no reason.

At the moment the room says 2.2 and the queue runs ten workers, which is
the cap. The remaining limits are the machine's disk (24 % of its time
waiting for I/O) and the provider, which has started answering 429.

## The order to do it in

1. **The pool instead of the batch.** Done: 4.4 - 7 became 16 - 32
   analyses per minute, with the same plan usage.
2. **The database in memory.** Done: `shared_buffers` 4 GB. The same
   `UPDATE` went from 710 ms to 4 ms.
3. **Fewer index writes per analysis.** The next one: the AI status out of
   `images`, so the updates become HOT. It is worth about 8x on the
   database cost.
4. **The cap and the brake.** The cap is ten workers; the weekly window
   is the brake and it has not fired. Both are in place.
