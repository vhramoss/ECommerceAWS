import { Context, S3Event, S3EventRecord } from "aws-lambda"
import { S3, DynamoDB, ApiGatewayManagementApi, EventBridge } from "aws-sdk"
import * as AWSXRay from "aws-xray-sdk"
import { InvoiceTransactionRepository, InvoiceTransactionStatus } from "/opt/nodejs/invoiceTransaction"
import { InvoiceWSService } from "/opt/nodejs/invoiceWSConnection"
import { InvoiceFile, InvoiceRepository } from "/opt/nodejs/invoiceRepository"

AWSXRay.captureAWS(require('aws-sdk'))

const invoicesDdb = process.env.INVOICE_DDB!
const invoicesWSApiEndpoint = process.env.INVOICE_WSAPI_ENDPOINT!.substring(6)
const auditBusName = process.env.AUDIT_BUS_NAME!

const s3Client = new S3()
const ddbClient = new DynamoDB.DocumentClient()
const apigwManagementApi = new ApiGatewayManagementApi({
    endpoint: invoicesWSApiEndpoint
})
const eventBridgeClient = new EventBridge()

const invoiceTransactionRepository = new InvoiceTransactionRepository(ddbClient, invoicesDdb)
const invoiceWSService = new InvoiceWSService(apigwManagementApi)
const invoiceRepository = new InvoiceRepository(ddbClient, invoicesDdb)

export async function handler(event: S3Event, context: Context): Promise<void> {
    const promises: Promise<void>[] = []
    event.Records.forEach((record) => {
        promises.push(processRecord(record))
    })

    await Promise.all(promises)
    return
}

async function processRecord(record: S3EventRecord): Promise<void> {
    const key = record.s3.object.key
    let connectionId: string | undefined

    try {
        const invoiceTransaction = await invoiceTransactionRepository.getInvoiceTransaction(key)
        connectionId = invoiceTransaction.connectionId

        if (invoiceTransaction.transactionStatus === InvoiceTransactionStatus.GENERATED) {
            await Promise.all([
                invoiceWSService.sendInvoiceStatus(key, connectionId, InvoiceTransactionStatus.RECEIVED),
                invoiceTransactionRepository.updateInvoiceTransaction(key, InvoiceTransactionStatus.RECEIVED)
            ])
        } else {
            await invoiceWSService.sendInvoiceStatus(key, connectionId, invoiceTransaction.transactionStatus)
            console.error(`Non valid transaction status: ${invoiceTransaction.transactionStatus}`)
            return
        }

        const object = await s3Client.getObject({
            Key: key,
            Bucket: record.s3.bucket.name
        }).promise()

        const invoice = JSON.parse(object.Body!.toString('utf-8')) as InvoiceFile

        if (invoice.invoiceNumber.length < 5) {
            console.error(`Invalid invoice number: ${invoice.invoiceNumber}`)
            
            await eventBridgeClient.putEvents({
                Entries: [{
                    Source: 'app.invoice',
                    EventBusName: auditBusName,
                    DetailType: 'invoice',
                    Time: new Date(),
                    Detail: JSON.stringify({
                        errorDetail: 'FAIL_NO_INVOICE_NUMBER',
                        info: { invoiceKey: key, customerName: invoice.customerName }
                    })
                }]
            }).promise()

            await Promise.all([
                invoiceWSService.sendInvoiceStatus(key, connectionId, InvoiceTransactionStatus.NON_VALID_INVOICE_NUMBER),
                invoiceTransactionRepository.updateInvoiceTransaction(key, InvoiceTransactionStatus.NON_VALID_INVOICE_NUMBER)
            ])
            return
        }

        console.log(invoice)

        const createInvoicePromise = invoiceRepository.create({
            pk: `#invoice_${invoice.customerName}`,
            sk: invoice.invoiceNumber,
            ttl: 0,
            totalValue: invoice.totalValue,
            productId: invoice.productId,
            quantity: invoice.quantity,
            transactionId: key,
            createdAt: Date.now()
        })

        const deleteObjectPromise = s3Client.deleteObject({
            Key: key,
            Bucket: record.s3.bucket.name
        }).promise()

        const updateInvoicePromise = invoiceTransactionRepository.updateInvoiceTransaction(key, InvoiceTransactionStatus.PROCESSED)
        const sendStatusPromise = invoiceWSService.sendInvoiceStatus(key, connectionId, InvoiceTransactionStatus.PROCESSED)

        await Promise.all([createInvoicePromise, deleteObjectPromise, updateInvoicePromise, sendStatusPromise])

    } catch (error) {
        console.log((<Error>error).message)
    } finally {
        // Garantia de desconexão, mesmo em caso de falha ou sucesso
        if (connectionId) {
            await apigwManagementApi.deleteConnection({ ConnectionId: connectionId }).promise().catch(() => {
                console.log(`Connection ${connectionId} already closed or not found.`)
            })
        }
    }
}