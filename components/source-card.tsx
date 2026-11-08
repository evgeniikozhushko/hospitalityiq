import type { Source } from "@/lib/schema"
import { sourceElementId } from "@/lib/focusSource"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * One retrieved review. It is a programmatic focus target (tabIndex -1) so a citation link can
 * move focus here; the focus ring uses :focus, not :focus-visible, so it shows after a click.
 * Review text is rendered as a plain text node, never as HTML.
 */
export function SourceCard({ source }: { source: Source }) {
  const id = sourceElementId(source.n)
  const titleId = `${id}-title`
  return (
    <Card
      id={id}
      role="article"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="scroll-mt-20 focus:ring-2 focus:ring-ring focus:outline-none"
    >
      <CardHeader>
        <CardTitle id={titleId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>[{source.n}]</span>
          <span>{source.propertyName}</span>
          <Badge variant="secondary">{source.propertyType}</Badge>
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          <span aria-label={`${source.rating} out of 5 stars`}>{source.rating}★</span>
          <span aria-hidden="true"> · </span>
          <time dateTime={source.createdAt}>{source.createdAt.slice(0, 10)}</time>
        </div>
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-line">{source.text}</CardContent>
    </Card>
  )
}
