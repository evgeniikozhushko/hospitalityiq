"use client"

import * as React from "react"
import { AlertCircleIcon, InfoIcon } from "lucide-react"

import { Answer } from "@/components/answer"
import { SourceCard } from "@/components/source-card"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { alertRole, type AlertKind } from "@/lib/alertRole"
import { createAskController, type AskController } from "@/lib/askController"
import { askReducer, initialAskState, isTerminal } from "@/lib/askState"
import { statusMessage } from "@/lib/askStatus"
import { planChips } from "@/lib/planChips"

const MIN_LENGTH = 3
const MAX_LENGTH = 500

function Notice({
  kind,
  title,
  children,
  action,
}: {
  kind: AlertKind
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  const failure = alertRole(kind) === "alert"
  return (
    <Alert role={alertRole(kind)} variant={failure ? "destructive" : "default"}>
      {failure ? <AlertCircleIcon aria-hidden="true" /> : <InfoIcon aria-hidden="true" />}
      <AlertTitle>{title}</AlertTitle>
      {children ? <AlertDescription>{children}</AlertDescription> : null}
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  )
}

function SourcesSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-3 sm:grid-cols-2">
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
    </div>
  )
}

function AnswerSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  )
}

export function Chat() {
  const [state, dispatch] = React.useReducer(askReducer, initialAskState)
  const [text, setText] = React.useState("")
  const controllerRef = React.useRef<AskController | null>(null)
  const inputId = React.useId()
  const helpId = React.useId()

  // One controller per mount. Disposing on cleanup aborts any live request and silences it, which
  // also keeps React Strict Mode's mount/unmount/mount from leaving a request running.
  React.useEffect(() => {
    const controller = createAskController({ dispatch })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [])

  const trimmedLength = text.trim().length
  const valid = trimmedLength >= MIN_LENGTH && trimmedLength <= MAX_LENGTH
  const tooLong = trimmedLength > MAX_LENGTH

  function submit() {
    if (!valid) return
    void controllerRef.current?.submit(text.trim())
  }

  function retry() {
    void controllerRef.current?.retry()
  }

  const { status, plan } = state
  const inFlight = status !== "idle" && !isTerminal(status)
  const isReview = plan?.intent === "review_insight"
  const chips = plan && isReview ? planChips(plan.filters) : []
  const retryButton = (
    <Button type="button" variant="outline" size="sm" onClick={retry}>
      Retry
    </Button>
  )

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
      {/* The only live region for progress. Its text depends on the phase, never on the answer
          text, so streamed deltas are not re-announced. Failures use their own role="alert". */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusMessage(state)}
      </p>

      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Ask about guest reviews</h1>
        <p className="text-sm text-muted-foreground">
          Answers come from guest reviews, with the reviews cited.
        </p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label htmlFor={inputId} className="text-sm font-medium">
          Your question
        </label>
        <Textarea
          id={inputId}
          value={text}
          rows={3}
          placeholder="What are guests complaining about most at Banff Caribou Lodge?"
          aria-describedby={helpId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <p id={helpId} className="text-xs text-muted-foreground">
            Each question is answered on its own; follow-ups don&apos;t see earlier answers.{" "}
            <span className={tooLong ? "text-destructive" : undefined}>
              {trimmedLength}/{MAX_LENGTH}
            </span>
          </p>
          <Button type="submit" disabled={!valid}>
            Ask
          </Button>
        </div>
      </form>

      {status !== "idle" ? (
        <div className="flex flex-col gap-4">
          {status === "connecting" ? (
            <div aria-hidden="true" className="flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-16" />
            </div>
          ) : null}

          {chips.length > 0 || (plan && isReview) ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Searching:</span>
              {chips.length > 0 ? (
                chips.map((chip) => (
                  <Badge key={chip} variant="secondary">
                    {chip}
                  </Badge>
                ))
              ) : (
                <Badge variant="secondary">All reviews</Badge>
              )}
            </div>
          ) : null}

          {state.droppedPropertyNames.length > 0 ? (
            <Notice kind="dropped_properties" title="Property not recognised">
              No property called {state.droppedPropertyNames.map((n) => `“${n}”`).join(", ")} was
              found, so that name was ignored.
            </Notice>
          ) : null}

          {state.relaxed ? (
            <Notice kind="relaxed" title="Showing the closest results">
              No reviews matched the date or rating filters exactly.
            </Notice>
          ) : null}

          {status === "planned" && !isReview ? (
            <div aria-hidden="true">
              <Skeleton className="h-16" />
            </div>
          ) : null}

          {(status === "planned" && isReview) || (status === "sources" && state.answer === "") ? (
            <section aria-label="Answer" aria-busy="true">
              <AnswerSkeleton />
            </section>
          ) : null}

          {state.answer !== "" ? (
            <section aria-label="Answer" aria-busy={inFlight}>
              <Answer
                text={state.answer}
                sourceNumbers={state.sources.map((s) => s.n)}
                streaming={inFlight}
              />
            </section>
          ) : null}

          {status === "declined" ? (
            <Notice kind="declined" title="That can’t be answered yet">
              {state.message}
            </Notice>
          ) : null}

          {status === "no_data" ? (
            <Notice kind="no_data" title="No matching reviews">
              {state.message}
            </Notice>
          ) : null}

          {status === "error" ? (
            <Notice kind="error" title="Something went wrong" action={retryButton}>
              {state.error}
            </Notice>
          ) : null}

          {status === "incomplete" ? (
            <Notice kind="incomplete" title="This answer may be incomplete" action={retryButton}>
              The connection ended before the answer finished.
            </Notice>
          ) : null}

          {status === "planned" && isReview ? (
            <SourcesSkeleton />
          ) : state.sources.length > 0 ? (
            <section aria-labelledby="sources-heading" className="flex flex-col gap-3">
              <h2 id="sources-heading" className="text-sm font-medium">
                Sources
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {state.sources.map((source) => (
                  <SourceCard key={source.n} source={source} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
