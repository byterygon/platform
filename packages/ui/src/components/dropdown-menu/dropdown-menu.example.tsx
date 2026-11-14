import { useState } from "react";
import { Button } from "@/components/button/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/dropdown-menu/dropdown-menu";
import { IconButton } from "@/components/icon-button/icon-button";

const MoreIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

/** The smallest useful DropdownMenu: a few actions under an icon button. */
export function DropdownMenuMinimal() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<IconButton aria-label="Tab actions" variant="ghost" />}>
        <MoreIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
        <DropdownMenuItem>Duplicate</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger>Close tab</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The results toolbar's copy menu: actions with shortcuts, a "Copy as" submenu, a radio group for
 * the delimiter, checkbox options, a disabled action and a group label.
 */
export function DropdownMenuRealistic() {
  const [delimiter, setDelimiter] = useState("tab");
  const [headers, setHeaders] = useState(true);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="secondary" size="sm" />}>Copy</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Selection</DropdownMenuLabel>
          <DropdownMenuItem>
            Copy cells
            <DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            Copy with headers
            <DropdownMenuShortcut>Ctrl+Shift+C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Copy as</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>CSV</DropdownMenuItem>
              <DropdownMenuItem>JSON</DropdownMenuItem>
              <DropdownMenuItem>SQL INSERT statements</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem disabled>Copy column statistics</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Delimiter</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={delimiter} onValueChange={(value) => setDelimiter(value as string)}>
            <DropdownMenuRadioItem value="tab">Tab</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="comma">Comma</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="semicolon">Semicolon</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={headers} onCheckedChange={setHeaders}>
          Include headers
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
