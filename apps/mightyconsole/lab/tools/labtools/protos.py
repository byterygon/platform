"""The descriptors of schemas/lab/common/money.proto and schemas/lab/orders/order.proto, built in
code so the lab needs no protoc. Keep them in step with the .proto files."""

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

F = descriptor_pb2.FieldDescriptorProto


def _field(message, name, number, kind, label=F.LABEL_OPTIONAL, type_name=None):
    field = message.field.add(name=name, number=number, type=kind, label=label)
    field.json_name = "".join(p if i == 0 else p.capitalize() for i, p in enumerate(name.split("_")))
    if type_name:
        field.type_name = type_name
    return field


def file_protos():
    money = descriptor_pb2.FileDescriptorProto(name="lab/common/money.proto", package="lab.common", syntax="proto3")
    m = money.message_type.add(name="Money")
    _field(m, "currency", 1, F.TYPE_STRING)
    _field(m, "units", 2, F.TYPE_INT64)
    _field(m, "nanos", 3, F.TYPE_INT32)

    order = descriptor_pb2.FileDescriptorProto(name="lab/orders/order.proto", package="lab.orders", syntax="proto3")
    order.dependency.append("lab/common/money.proto")
    o = order.message_type.add(name="Order")
    status = o.enum_type.add(name="Status")
    for number, name in enumerate(["STATUS_UNSPECIFIED", "PLACED", "PAID", "SHIPPED"]):
        status.value.add(name=name, number=number)
    _field(o, "id", 1, F.TYPE_STRING)
    _field(o, "customer", 2, F.TYPE_STRING)
    _field(o, "total", 3, F.TYPE_MESSAGE, type_name=".lab.common.Money")
    _field(o, "items", 4, F.TYPE_STRING, label=F.LABEL_REPEATED)
    _field(o, "status", 5, F.TYPE_ENUM, type_name=".lab.orders.Order.Status")
    return money, order


_pool = descriptor_pool.Default()
for _proto in file_protos():
    try:
        _pool.FindFileByName(_proto.name)
    except KeyError:
        _pool.Add(_proto)

Order = message_factory.GetMessageClass(_pool.FindMessageTypeByName("lab.orders.Order"))
Money = message_factory.GetMessageClass(_pool.FindMessageTypeByName("lab.common.Money"))


def order(i: int):
    """The i-th sample order."""
    return Order(
        id=f"ord-{i:05d}",
        customer=f"customer-{i % 17}",
        total=Money(currency="EUR", units=10 + i % 90, nanos=(i * 10_000_000) % 1_000_000_000),
        items=[f"sku-{(i * 7) % 31}", f"sku-{(i * 11) % 29}"],
        status=1 + i % 3,
    )
