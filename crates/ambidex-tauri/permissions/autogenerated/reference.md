## Default Permission

Allows the Ambidex RPC transport: open a connection, send client frames, close it.

Grant this only to the bundled `main` window loading local content, in a capability without
`remote` URLs (Ambidex spec §8). Remote content then has no IPC access to the core.

#### This default permission set includes the following:

- `allow-connect`
- `allow-send`
- `allow-close`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`ambidex-tauri:allow-close`

</td>
<td>

Enables the close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ambidex-tauri:deny-close`

</td>
<td>

Denies the close command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ambidex-tauri:allow-connect`

</td>
<td>

Enables the connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ambidex-tauri:deny-connect`

</td>
<td>

Denies the connect command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ambidex-tauri:allow-send`

</td>
<td>

Enables the send command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`ambidex-tauri:deny-send`

</td>
<td>

Denies the send command without any pre-configured scope.

</td>
</tr>
</table>
