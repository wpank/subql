import {SubstrateExtrinsic,SubstrateEvent,SubstrateBlock} from "@subql/types";
import { Nomination, Validator, Nominator, ValidatorNomination } from "../types";
import {Balance} from "@polkadot/types/interfaces";


// export async function handleBlock(block: SubstrateBlock): Promise<void> {
//     //Create a new starterEntity with ID using block hash
//     let record = new StarterEntity(block.block.header.hash.toString());
//     //Record block number
//     record.field1 = block.block.header.number.toNumber();
//     await record.save();
// }
//
// export async function handleEvent(event: SubstrateEvent): Promise<void> {
//     const {event: {data: [account, balance]}} = event;
//     //Retrieve the record by its ID
//     const record = await StarterEntity.get(event.block.block.header.hash.toString());
//     record.field2 = account.toString();
//     //Big integer type Balance of a transfer event
//     record.field3 = (balance as Balance).toBigInt();
//     await record.save();
// }

// Called before updating the current validators of a nominator
// This takes the diff of the old validators and new validators, and if
//     the validator was removed from the nomination, removes the nominator
//     from the list of `allNominators` for the validator
export const updateRemovedValidators = async(nominator, nominatorTargets) => {
    const prevValidators = nominator.currentValidators
    if (prevValidators){
        const removedValidators = prevValidators.filter(x => !nominatorTargets.includes(x))
        for (const val of removedValidators) {
            const validator = await Validator.get(val.toString())
            const allNominators = validator.allNominators
            const inactiveNominators = validator.inactiveNominators
            if (allNominators){
                const index = allNominators.indexOf(nominator.stash)
                if (index > -1){
                    allNominators.splice(index, 1);
                    validator.allNominators = allNominators
                    await validator.save();
                }
            }
            if (inactiveNominators){
                const index = inactiveNominators.indexOf(nominator.stash)
                if (index > -1){
                    inactiveNominators.splice(index, 1);
                    validator.inactiveNominators = inactiveNominators
                    await validator.save();
                }
            }
        }
    }
}

export const createOrUpdateNominator = async(nominatorStash, nominatorTargets, submittedIn, bond) => {
    let nominator = await Nominator.get(nominatorStash)
    if (!nominator) {
        nominator = new Nominator(nominatorStash)
        nominator.stash = nominatorStash
    }

    await updateRemovedValidators(nominator, nominatorTargets)

    nominator.currentValidators = nominatorTargets
    nominator.submittedIn = submittedIn
    nominator.bond = bond
    await nominator.save()
}

export const createNomination = async(extrinsicHash, nominatorStash, blockNumber) => {
    let nomination = new Nomination(extrinsicHash)
    // @ts-ignore
    nomination.nominatorId = nominatorStash.toString();
    nomination.blockNumber = blockNumber;
    await nomination.save()
}

export const updateValidator = async(validatorStash, currentEra, nominatorStash) => {
    // Get Era Exposure
    const erasStakers = (await api.query.staking.erasStakers(currentEra, validatorStash));
    // @ts-ignore
    const {total, own, others} = erasStakers
    const activeNominators = others.map((nominator)=> {
        return nominator.who.toString()
    })

    let validator = await Validator.get(validatorStash);
    if (!validator) {
        validator = new Validator(validatorStash);
        validator.stash = validatorStash;
        validator.allNominators = [nominatorStash]
    } else {
        // The validator was included in a nominators nomination
        //  add the nominator to the list of all nominators if it isn't already there
        const index = validator.allNominators.indexOf(nominatorStash)
        if (index == -1){
            const allNominators = validator.allNominators
            allNominators.push(nominatorStash)
            validator.allNominators = allNominators
        }
    }

    const inactiveNominators = validator.allNominators.filter(x => !activeNominators.includes(x))
    validator.inactiveNominators = inactiveNominators

    let totalStake = BigInt(0)
    for (const nom of validator.allNominators){
        const nominator = await  Nominator.get(nom.toString())
        if (nominator && nominator.bond > 0){
            totalStake += nominator.bond
        }
    }

    let inactiveStake = BigInt(0)
    for (const nom of validator.inactiveNominators){
        const nominator = await Nominator.get(nom.toString())
        if (nominator && nominator.bond > 0){
            inactiveStake += nominator.bond
        }
    }

    validator.activeStake = total
    validator.selfStake = own
    validator.inactiveStake = inactiveStake
    validator.activeNominators = activeNominators

    await validator.save()
}

export async function handleStakingNominate(extrinsicHash, controller, blockNumber, args): Promise<void> {
    const ledgerQuery = (await api.query.staking.ledger(controller)).toJSON()

    const nominatorStash = ledgerQuery['stash']
    const nominatorBond = BigInt(ledgerQuery['total'])

    const currentEra = (await api.query.staking.currentEra()).toString();

    const { targets } = args;
    const nominatorTargets = targets.map((target)=>{return target['Id'] ? target['Id'] : target})

    // let nominator = await Nominator.get(nominatorStash)
    // if (!nominator) {
    //     nominator = new Nominator(nominatorStash)
    //     nominator.stash = nominatorStash
    // }
    //
    // await updateRemovedValidators(nominator, nominatorTargets)
    //
    // nominator.currentValidators = nominatorTargets
    // nominator.submittedIn = currentEra
    // nominator.bond = nominatorBond
    // await nominator.save()
    await createOrUpdateNominator(nominatorStash, nominatorTargets, currentEra, nominatorBond)

    await createNomination(extrinsicHash, nominatorStash, blockNumber)
    // let nomination = new Nomination(extrinsicHash)
    // // @ts-ignore
    // nomination.nominatorId = nominatorStash.toString();
    // nomination.blockNumber = blockNumber;
    // await nomination.save()

    // const nominators = await api.query.staking.nominators.entries();
    // logger.info(JSON.stringify(nominators))


    // logger.info(`targets from args`)
    // logger.info(JSON.stringify(targets))
    const nominations = await Promise.all(targets.map(async (target) => {
        const validatorStash = target["Id"] ? target['Id'] : target

        logger.info(`validator stash: ${validatorStash} currentEra: ${currentEra}`)
        // const erasStakers = (await api.query.staking.erasStakers(currentEra, validatorStash));
        // logger.info(JSON.stringify(erasStakers))
        // // @ts-ignore
        // const {total, own, others} = erasStakers
        // const activeNominators = others.map((nominator)=> {
        //     return nominator.who.toString()
        // })
        // logger.info(`total`)
        // logger.info(JSON.stringify(total))
        // logger.info(`own`)
        // logger.info(JSON.stringify(own))


        // const allNominators = await Promise.all(
        //     nominators
        //         .filter(([key, value]) => {
        //             // @ts-ignore
        //             return value.toHuman().targets.includes(validatorStash);
        //         })
        //         .map(async ([key, value]) => {
        //             const address = key.toHuman()[0];
        //             // const identity = await getIdentity(api, address);
        //             const controller = await api.query.staking.bonded(address);
        //             // @ts-ignore
        //             const bonded =
        //                 (await api.query.staking.ledger(controller.toString())).toJSON()['active'];
        //             return {
        //                 address: address,
        //                 // identity: identity,
        //                 bonded: bonded,
        //             };
        //         })
        // );
        // const inactiveNominators = allNominators.filter((nominator) => {
        //     let active = false;
        //     activeNominators.forEach((other) => {
        //         if (other.address === nominator.address) {
        //             active = true;
        //         }
        //     });
        //     return !active;
        // });

        // let totalInactiveStake = BigInt('0');
        // inactiveNominators.forEach((nominator) => {
        //     totalInactiveStake += BigInt(nominator.bonded);
        // });



        // let validator = await Validator.get(validatorStash);
        // if (!validator) {
        //     validator = new Validator(validatorStash);
        //     validator.stash = validatorStash;
        //     validator.activeStake = total
        //     validator.selfStake = own
        //     // validator.inactiveStake = totalInactiveStake
        //     validator.activeNominators = activeNominators
        //     validator.allNominators = [nominatorStash]
        //     await validator.save()
        // } else {
        //     const index = validator.allNominators.indexOf(nominatorStash)
        //     if (index == -1){
        //         // logger.info(`found the index of the nominator`)
        //         const allNominators = validator.allNominators
        //         allNominators.push(nominatorStash)
        //         validator.allNominators = allNominators
        //         await validator.save()
        //     }
        // }
        await updateValidator(validatorStash, currentEra, nominatorStash)

        const validatorNominationId = `${nominatorStash}-${validatorStash}-${blockNumber}`
        await createValidatorNomination(validatorNominationId, blockNumber, nominatorStash, validatorStash, extrinsicHash, nominatorBond)


        // return validator
    }));
    // logger.info(JSON.stringify(nominations))
}

export  const createValidatorNomination = async(id, blockNumber, nominatorStash, validatorStash, extrinsicHash, bond) => {
    let validatorNomination = await ValidatorNomination.get(id)
    if (!validatorNomination) {
        validatorNomination = new ValidatorNomination(id);
        validatorNomination.blockNumber = blockNumber
        //@ts-ignore
        validatorNomination.nominatorId = nominatorStash
        //@ts-ignore
        validatorNomination.validatorId = validatorStash
        //@ts-ignore
        validatorNomination.nominationId = extrinsicHash
        await validatorNomination.save()
    }
}

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
    if (!extrinsic.success) { return }
    const extrinsicHash = extrinsic.block.block.header.hash.toString();
    const blockNumber = parseInt(extrinsic.block.block.header.number.toString())
    const {  block, events } = extrinsic
    // logger.info('block')
    // logger.info(block.block.toString())
    // logger.info('events')
    // logger.info(events.toString())
    // logger.info('extrsinic')
    // logger.info(extrinsic.extrinsic.toString())

    //@ts-ignore
    const {isSigned, signer, method: {args, method: palletMethod, section}} = extrinsic.extrinsic.toHuman();
    switch (section) {
        case "imOnline":
            break;
        case "staking":
            logger.info(`there was a staking extrinsic: ${palletMethod}`)
            switch(palletMethod){
                case "nominate":
                    logger.info(`pallet method is nominate: ${palletMethod}`)
                    logger.info(`signer: ${signer} ${signer['Id']}`)
                    const controller = signer['Id'] ? signer['Id'] : signer
                    await handleStakingNominate(extrinsicHash, controller, blockNumber, args)


                    break;
                default:
                    break;
            }
            break;
        case "timestamp":
            // @ts-ignore
            const {now} = args;
            const timestamp = now?.replace(/,/g, '');
            // logger.info(`timestamp: ${now}`);
            break;

        default:
            break;
    }
    // logger.info(`method: ${palletMethod.toString()} section: ${section}`)


    //Date type timestamp


    // await record.save();
}


