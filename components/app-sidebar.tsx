"use client"

import * as React from "react"
import Link from "next/link"
import {
  HotelIcon,
  MegaphoneIcon,
  MessageSquareTextIcon,
  TrendingUpIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/** Not built yet. Shown, but not usable, so the roadmap is visible. */
const comingSoon: { title: string; icon: LucideIcon }[] = [
  { title: "Trends", icon: TrendingUpIcon },
  { title: "Campaigns", icon: MegaphoneIcon },
  { title: "Admin upload", icon: UploadIcon },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar
      className="top-(--header-height) h-[calc(100svh-var(--header-height))]!"
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <HotelIcon className="size-4" aria-hidden="true" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">HospitalityIQ</span>
                  <span className="truncate text-xs">Banff Caribou Properties</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <Link href="/" aria-current="page">
                    <MessageSquareTextIcon aria-hidden="true" />
                    <span>Ask</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {comingSoon.map(({ title, icon: Icon }) => (
                <SidebarMenuItem key={title}>
                  {/* Focusable but inert. The explanation is visible text and part of the
                      accessible name, not a hover-only tooltip. */}
                  <SidebarMenuButton
                    aria-disabled="true"
                    onClick={(event) => event.preventDefault()}
                  >
                    <Icon aria-hidden="true" />
                    <span>
                      {title}
                      <span className="sr-only">, coming soon</span>
                    </span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge aria-hidden="true">Soon</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
