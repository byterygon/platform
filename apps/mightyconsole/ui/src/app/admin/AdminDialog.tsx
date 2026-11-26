// Users and roles (TSK-135 §5, DOC-25 §3.3): the three screens of administration in one large
// dialog, opened from the account menu and the palette by people who hold `admin.users.read`.
// Everything it shows comes from `admin.*`, and each change goes back through it: the server decides.
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MightyClient } from "../client";
import { GroupsPane } from "./GroupsPane";
import { RolesPane } from "./RolesPane";
import { UsersPane } from "./UsersPane";
import { useProfileChoices } from "./parts";

export interface AdminDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: MightyClient;
  /** The caller's own user id. */
  selfId: string;
}

export function AdminDialog({ open, onOpenChange, client, selfId }: AdminDialogProps) {
  const profiles = useProfileChoices(client);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl">
      <DialogContent data-testid="admin-dialog" className="min-h-panel-lg">
        <DialogHeader>
          <DialogTitle>Users and roles</DialogTitle>
          <DialogDescription>Who can use this server and what each role allows. People come from the identity provider; changes apply to the next call.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col">
          <Tabs defaultValue="users" className="flex min-h-0 flex-1 flex-col gap-stack-md">
            <TabsList aria-label="Administration">
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="roles">Roles</TabsTrigger>
              <TabsTrigger value="groups">Group mapping</TabsTrigger>
            </TabsList>
            <TabsContent value="users" className="flex min-h-0 flex-1 flex-col">
              <UsersPane client={client} profiles={profiles} selfId={selfId} />
            </TabsContent>
            <TabsContent value="roles" className="flex min-h-0 flex-1 flex-col">
              <RolesPane client={client} />
            </TabsContent>
            <TabsContent value="groups" className="flex min-h-0 flex-1 flex-col">
              <GroupsPane client={client} profiles={profiles} />
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
