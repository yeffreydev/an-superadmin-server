import {
  Controller, Get, Post, Put, Delete, Param, Body, UseGuards,
  HttpException, HttpStatus,
} from '@nestjs/common';
import { ClientStage, ContactKind, AttributeType } from '@prisma/client';
import {
  ClientsService, ClientUpdateDto, ClientCreateDto,
  ContactInput, ContactUpdateInput,
  AttributeInput, AttributeUpdateInput,
} from './clients.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('clients')
@UseGuards(AuthGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list() {
    return this.clients.listClients();
  }

  @Get('available-tenants')
  availableTenants() {
    return this.clients.listAvailableTenants();
  }

  @Post('sync')
  sync() {
    return this.clients.syncFromTenants();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.clients.getClient(id);
  }

  @Post()
  async create(@Body() body: ClientCreateDto) {
    if (body.stage && !Object.values(ClientStage).includes(body.stage)) {
      throw new HttpException('Etapa inválida', HttpStatus.BAD_REQUEST);
    }
    if (body.contacts) {
      for (const c of body.contacts) {
        if (c.kind && !Object.values(ContactKind).includes(c.kind)) {
          throw new HttpException('Tipo de contacto inválido', HttpStatus.BAD_REQUEST);
        }
      }
    }
    return this.clients.createClient(body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: ClientUpdateDto) {
    if (body.stage && !Object.values(ClientStage).includes(body.stage)) {
      throw new HttpException('Etapa inválida', HttpStatus.BAD_REQUEST);
    }
    return this.clients.updateClient(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.clients.deleteClient(id);
  }

  @Post(':id/assign-tenant')
  assignTenant(@Param('id') id: string, @Body() body: { tenantId: string }) {
    if (!body?.tenantId) {
      throw new HttpException('tenantId es requerido', HttpStatus.BAD_REQUEST);
    }
    return this.clients.assignTenant(id, body.tenantId);
  }

  @Post(':id/unassign-tenant')
  unassignTenant(@Param('id') id: string) {
    return this.clients.unassignTenant(id);
  }

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() body: { content: string; author?: string },
  ) {
    return this.clients.addComment(id, body?.content, body?.author);
  }

  @Delete(':id/comments/:commentId')
  removeComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.clients.deleteComment(id, commentId);
  }

  @Get(':id/contacts')
  listContacts(@Param('id') id: string) {
    return this.clients.listContacts(id);
  }

  @Post(':id/contacts')
  addContact(@Param('id') id: string, @Body() body: ContactInput) {
    if (body.kind && !Object.values(ContactKind).includes(body.kind)) {
      throw new HttpException('Tipo de contacto inválido', HttpStatus.BAD_REQUEST);
    }
    return this.clients.addContact(id, body);
  }

  @Put(':id/contacts/:contactId')
  updateContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() body: ContactUpdateInput,
  ) {
    if (body.kind && !Object.values(ContactKind).includes(body.kind)) {
      throw new HttpException('Tipo de contacto inválido', HttpStatus.BAD_REQUEST);
    }
    return this.clients.updateContact(id, contactId, body);
  }

  @Delete(':id/contacts/:contactId')
  removeContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return this.clients.deleteContact(id, contactId);
  }

  @Get(':id/attributes')
  listAttributes(@Param('id') id: string) {
    return this.clients.listAttributes(id);
  }

  @Post(':id/attributes')
  addAttribute(@Param('id') id: string, @Body() body: AttributeInput) {
    if (body.type && !Object.values(AttributeType).includes(body.type)) {
      throw new HttpException('Tipo de atributo inválido', HttpStatus.BAD_REQUEST);
    }
    return this.clients.addAttribute(id, body);
  }

  @Put(':id/attributes/:attributeId')
  updateAttribute(
    @Param('id') id: string,
    @Param('attributeId') attributeId: string,
    @Body() body: AttributeUpdateInput,
  ) {
    if (body.type && !Object.values(AttributeType).includes(body.type)) {
      throw new HttpException('Tipo de atributo inválido', HttpStatus.BAD_REQUEST);
    }
    return this.clients.updateAttribute(id, attributeId, body);
  }

  @Delete(':id/attributes/:attributeId')
  removeAttribute(
    @Param('id') id: string,
    @Param('attributeId') attributeId: string,
  ) {
    return this.clients.deleteAttribute(id, attributeId);
  }
}
