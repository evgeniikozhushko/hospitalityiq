import { AppSidebar } from "@/components/app-sidebar"
import { Chat } from "@/components/chat"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export default function Home() {
  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <Chat />
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  )
}
