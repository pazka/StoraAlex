import { Type } from '@fastify/type-provider-typebox';

// Reusable primitives. All object bodies set additionalProperties:false so
// unknown fields are rejected (SPEC §7.4).
const obj = <T extends Parameters<typeof Type.Object>[0]>(props: T) =>
  Type.Object(props, { additionalProperties: false });

// Entity-ID / foreign-key integers: positive and bounded to the SQLite signed
// 32-bit range so out-of-range / precision-losing values are rejected at the edge.
const Id = Type.Integer({ minimum: 1, maximum: 2147483647 });
const Name = Type.String({ minLength: 1, maxLength: 200 });
const OptText = Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()]));
const OptPhoto = Type.Optional(Type.Union([Id, Type.Null()]));
const PlaceTypeT = Type.Union([Type.Literal('unit'), Type.Literal('shelf'), Type.Literal('crate')]);
const EntityTypeT = Type.Union([Type.Literal('item'), Type.Literal('place')]);
const MethodT = Type.Union([Type.Literal('scan'), Type.Literal('manual')]);
const TagKindT = Type.Union([Type.Literal('event'), Type.Literal('flag'), Type.Literal('other')]);
const CodeValue = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9\\-]+$' });
const IdParam = obj({ id: Id });

export const S = {
  // ---- auth ----
  login: {
    body: obj({
      username: Type.String({ minLength: 1, maxLength: 100 }),
      password: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
  },

  // ---- items ----
  itemsQuery: {
    querystring: obj({
      tag: Type.Optional(Id),
      place: Type.Optional(Id),
      status: Type.Optional(Type.Union([Type.Literal('in'), Type.Literal('out')])),
      q: Type.Optional(Type.String({ maxLength: 200 })),
    }),
  },
  createItem: {
    body: obj({
      name: Name,
      notes: OptText,
      photo_id: OptPhoto,
      location_place_id: Type.Optional(Type.Union([Id, Type.Null()])),
      code_value: Type.Optional(CodeValue),
      method: Type.Optional(MethodT),
    }),
  },
  patchItem: {
    params: IdParam,
    body: obj({ name: Type.Optional(Name), notes: OptText, photo_id: OptPhoto }),
  },
  moveItem: {
    params: IdParam,
    body: obj({
      to_place_id: Type.Union([Id, Type.Null()]),
      method: Type.Optional(MethodT),
      note: OptText,
    }),
  },
  itemTag: { params: IdParam, body: obj({ tag_id: Id }) },
  itemTagDelete: { params: obj({ id: Id, tagId: Id }) },
  byId: { params: IdParam },

  // ---- places ----
  placesQuery: {
    querystring: obj({
      parent: Type.Optional(Id),
      root: Type.Optional(Type.Boolean()),
      type: Type.Optional(PlaceTypeT),
    }),
  },
  createPlace: {
    body: obj({
      name: Name,
      type: PlaceTypeT,
      parent_place_id: Type.Optional(Type.Union([Id, Type.Null()])),
      info: OptText,
      photo_id: OptPhoto,
      code_value: Type.Optional(CodeValue),
      method: Type.Optional(MethodT),
    }),
  },
  patchPlace: {
    params: IdParam,
    body: obj({ name: Type.Optional(Name), info: OptText, photo_id: OptPhoto, type: Type.Optional(PlaceTypeT) }),
  },
  movePlace: {
    params: IdParam,
    body: obj({
      parent_place_id: Type.Union([Id, Type.Null()]),
      method: Type.Optional(MethodT),
      note: OptText,
    }),
  },

  // ---- codes ----
  resolve: { params: obj({ code: CodeValue }) },
  printCodes: {
    body: obj({
      type: EntityTypeT,
      count: Type.Integer({ minimum: 1, maximum: 200 }),
    }),
  },
  assignCode: {
    body: obj({ code_value: CodeValue, entity_type: EntityTypeT, entity_id: Id }),
  },

  // ---- tags ----
  createTag: {
    body: obj({
      name: Type.String({ minLength: 1, maxLength: 100 }),
      color: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
      kind: Type.Optional(TagKindT),
    }),
  },

  // ---- movements ----
  movementsQuery: {
    querystring: obj({
      entity_type: Type.Optional(EntityTypeT),
      entity_id: Type.Optional(Id),
      from: Type.Optional(Type.String({ maxLength: 40 })),
      to: Type.Optional(Type.String({ maxLength: 40 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
  },

  media: { params: obj({ id: Id }) },
};
