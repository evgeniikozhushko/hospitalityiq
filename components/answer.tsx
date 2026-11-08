"use client"

import * as React from "react"

import { tokenizeAnswer, type Inline } from "@/lib/answerText"
import { activateCitation, sourceElementId } from "@/lib/focusSource"

function onCitationClick(event: React.MouseEvent<HTMLAnchorElement>, n: number) {
  event.preventDefault()
  activateCitation(n, {
    getElementById: (id) => document.getElementById(id),
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  })
}

function Inlines({ items }: { items: Inline[] }) {
  return items.map((item, i) => {
    if (item.kind === "text") return <React.Fragment key={i}>{item.text}</React.Fragment>
    if (item.kind === "bold") {
      return (
        <strong key={i} className="font-semibold">
          <Inlines items={item.children} />
        </strong>
      )
    }
    return (
      <a
        key={i}
        href={`#${sourceElementId(item.n)}`}
        onClick={(event) => onCitationClick(event, item.n)}
        aria-label={`Source ${item.n}`}
        className="mx-0.5 rounded-sm px-0.5 align-baseline font-medium text-primary underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        [{item.n}]
      </a>
    )
  })
}

/**
 * Renders the model's answer as React elements only (never HTML). Pass the whole accumulated
 * text each time, so citations split across streamed chunks resolve correctly.
 */
export function Answer({
  text,
  sourceNumbers,
  streaming,
}: {
  text: string
  sourceNumbers: number[]
  streaming: boolean
}) {
  const blocks = tokenizeAnswer(text, sourceNumbers, { streaming })
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        if (block.kind === "paragraph") {
          return (
            <p key={i}>
              <Inlines items={block.children} />
            </p>
          )
        }
        const List = block.ordered ? "ol" : "ul"
        return (
          <List
            key={i}
            className={`flex flex-col gap-1.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
          >
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines items={item} />
              </li>
            ))}
          </List>
        )
      })}
    </div>
  )
}
